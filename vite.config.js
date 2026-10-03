import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MODEL_CATALOG } from "./src/lib/providers.js";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const EDGE_PYTHON =
  process.env.EDGE_TTS_PYTHON ||
  "C:/Users/xx/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe";
const EDGE_TTS_SCRIPT = process.env.EDGE_TTS_SCRIPT || path.join(projectRoot, "scripts", "edge_tts_speak.py");
const EDGE_TTS_TIMEOUT_MS = Number(process.env.EDGE_TTS_TIMEOUT_MS || 30000);
const EDGE_TTS_CACHE_MAX = 40;
const EDGE_TTS_MAX_CONCURRENCY = 2;

// TTS 结果缓存（key -> mp3 Buffer）。问题是固定文本，缓存命中率很高。
const ttsCache = new Map();
function ttsCacheGet(key) {
  if (!ttsCache.has(key)) return null;
  const value = ttsCache.get(key);
  ttsCache.delete(key);
  ttsCache.set(key, value);
  return value;
}
function ttsCacheSet(key, value) {
  ttsCache.set(key, value);
  while (ttsCache.size > EDGE_TTS_CACHE_MAX) {
    ttsCache.delete(ttsCache.keys().next().value);
  }
}

let ttsRunning = 0;
const ttsQueue = [];
function withTtsSlot(task) {
  return new Promise((resolve, reject) => {
    const run = () => {
      ttsRunning += 1;
      task()
        .then(resolve, reject)
        .finally(() => {
          ttsRunning -= 1;
          const next = ttsQueue.shift();
          if (next) next();
        });
    };
    if (ttsRunning < EDGE_TTS_MAX_CONCURRENCY) run();
    else ttsQueue.push(run);
  });
}

// 异步拉起 TTS 子进程：不再阻塞开发服务器事件循环。
function runTtsProcess(payloadFile, output) {
  return new Promise((resolve, reject) => {
    const child = spawn(EDGE_PYTHON, [EDGE_TTS_SCRIPT, payloadFile], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
        child.stdout?.destroy();
        child.stderr?.destroy();
      } catch {
        // process already gone
      }
      reject(new Error(`Edge TTS 超时（>${EDGE_TTS_TIMEOUT_MS}ms）`));
    }, EDGE_TTS_TIMEOUT_MS);
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-2000);
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0 && fs.existsSync(output)) resolve();
      else reject(new Error(stderr.trim() || `Edge TTS 退出码 ${code}`));
    });
  });
}

// baseUrl 白名单：默认只允许目录里预置的服务商域名，避免被当成任意请求的跳板（SSRF）。
const ALLOWED_MODEL_HOSTS = new Set(
  Object.values(MODEL_CATALOG)
    .map((config) => config.baseUrl)
    .filter(Boolean)
    .map((url) => new URL(url).hostname)
);
(process.env.ALLOW_MODEL_HOSTS || "")
  .split(",")
  .map((host) => host.trim().toLowerCase())
  .filter(Boolean)
  .forEach((host) => ALLOWED_MODEL_HOSTS.add(host));
const ALLOW_LOCAL_MODEL_HOST = process.env.ALLOW_LOCAL_MODEL_HOST === "1";

function resolveUpstreamUrl(raw) {
  let parsed;
  try {
    parsed = new URL(String(raw).trim());
  } catch {
    return { ok: false, error: "Base URL 不是合法地址" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, error: "Base URL 仅支持 http/https" };
  }
  const host = parsed.hostname.toLowerCase();
  const isLocal = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  if (!ALLOWED_MODEL_HOSTS.has(host) && !(ALLOW_LOCAL_MODEL_HOST && isLocal)) {
    return {
      ok: false,
      error: `Base URL 主机 ${host} 不在白名单内；如需接入，请在启动前设置 ALLOW_MODEL_HOSTS=${host}`
    };
  }
  const cleanBase = parsed.toString().replace(/\/+$/, "");
  return {
    ok: true,
    url: cleanBase.endsWith("/chat/completions") ? cleanBase : `${cleanBase}/chat/completions`
  };
}

function clampNumber(value, fallback, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function llmProxy() {
  async function handle(req, res) {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    try {
      const payload = await readJsonBody(req);
      const { baseUrl, apiKey, model, messages, maxTokens, temperature } = payload;
      if (!baseUrl || !apiKey || !model || !Array.isArray(messages)) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "baseUrl / apiKey / model / messages 不能为空" }));
        return;
      }
      const target = resolveUpstreamUrl(baseUrl);
      if (!target.ok) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: target.error }));
        return;
      }
      // 客户端断开（AbortController / 关闭页面）时同步中断上游请求，避免无谓的长等待。
      const controller = new AbortController();
      const abortUpstream = () => controller.abort();
      res.on("close", abortUpstream);
      let upstream;
      try {
        upstream = await fetch(target.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${String(apiKey).trim()}`
          },
          body: JSON.stringify({
            model,
            messages,
            temperature: clampNumber(temperature, 0.75, 0, 2),
            max_tokens: clampNumber(maxTokens, 1200, 16, 8192),
            stream: false
          }),
          signal: controller.signal
        });
      } catch (err) {
        if (controller.signal.aborted) {
          if (!res.writableEnded && !res.destroyed) {
            res.statusCode = 499;
            res.end(JSON.stringify({ error: "客户端已取消请求" }));
          }
          return;
        }
        throw err;
      } finally {
        res.off("close", abortUpstream);
      }
      const raw = await upstream.text();
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        data = { raw };
      }
      if (!upstream.ok) {
        const detail = data?.error?.message || data?.message || data?.raw || upstream.statusText;
        res.statusCode = 502;
        res.end(JSON.stringify({ error: `模型接口返回 ${upstream.status}: ${detail}` }));
        return;
      }
      const text = data?.choices?.[0]?.message?.content;
      if (!text) {
        res.statusCode = 502;
        res.end(JSON.stringify({ error: "模型没有返回内容", detail: data }));
        return;
      }
      res.end(JSON.stringify({ text }));
    } catch (err) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: `请求失败: ${err.message || err}` }));
    }
  }

  async function handleResumeParse(req, res) {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    try {
      const payload = await readJsonBody(req);
      const { name = "", dataBase64 = "" } = payload;
      const buffer = Buffer.from(String(dataBase64), "base64");
      const lower = String(name).toLowerCase();
      let text = "";
      if (lower.endsWith(".pdf")) {
        const parser = new PDFParse({ data: buffer });
        const parsed = await parser.getText();
        text = parsed.text || "";
        await parser.destroy();
      } else if (lower.endsWith(".docx")) {
        const parsed = await mammoth.extractRawText({ buffer });
        text = parsed.value || "";
      } else {
        text = buffer.toString("utf8");
      }
      const clean = text
        // eslint-disable-next-line no-control-regex -- 清理解析出来的 NUL 控制字符
        .replace(/\u0000/g, "")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      res.end(JSON.stringify({ text: clean, chars: clean.length }));
    } catch (err) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: `简历解析失败: ${err.message || err}` }));
    }
  }

  async function handleEdgeTts(req, res) {
    try {
      const payload = await readJsonBody(req);
      const { text = "", voice = "zh-CN-XiaoxiaoNeural", rate = "+4%", pitch = "+0Hz" } = payload;
      if (!String(text).trim()) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "text 不能为空" }));
        return;
      }
      const safeText = String(text).slice(0, 2500);
      const cacheKey = `${voice}|${rate}|${pitch}|${safeText}`;
      const cached = ttsCacheGet(cacheKey);
      if (cached) {
        res.setHeader("Content-Type", "audio/mpeg");
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Tts-Cache", "hit");
        res.end(cached);
        return;
      }
      const output = path.join(os.tmpdir(), `edge-tts-${Date.now()}-${Math.random().toString(16).slice(2)}.mp3`);
      const payloadFile = output.replace(/\.mp3$/, ".json");
      fs.writeFileSync(
        payloadFile,
        JSON.stringify({
          text: safeText,
          voice,
          rate,
          pitch,
          output
        }),
        "utf8"
      );
      try {
        await withTtsSlot(() => runTtsProcess(payloadFile, output));
      } catch (err) {
        res.statusCode = 502;
        res.end(JSON.stringify({ error: `Edge TTS 生成失败: ${String(err.message || err).slice(0, 500)}` }));
        return;
      } finally {
        try {
          fs.unlinkSync(payloadFile);
        } catch {
          // temp cleanup
        }
      }
      const audio = await fs.promises.readFile(output);
      try {
        fs.unlinkSync(output);
      } catch {
        // temp cleanup best effort
      }
      ttsCacheSet(cacheKey, audio);
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Cache-Control", "no-store");
      res.end(audio);
    } catch (err) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: `Edge TTS 请求失败: ${err.message || err}` }));
    }
  }

  return {
    name: "local-llm-proxy",
    configureServer(server) {
      server.middlewares.use("/api/llm", handle);
      server.middlewares.use("/api/parse-resume", handleResumeParse);
      server.middlewares.use("/api/edge-tts", handleEdgeTts);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/api/llm", handle);
      server.middlewares.use("/api/parse-resume", handleResumeParse);
      server.middlewares.use("/api/edge-tts", handleEdgeTts);
    }
  };
}

export default defineConfig({
  plugins: [react(), llmProxy()],
  server: {
    port: 4173,
    strictPort: false
  },
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.js"]
  }
});
