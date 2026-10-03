// 统一的 API 处理器：同一份实现同时供
//   1) Vite 开发/预览中间件（vite.config.js）
//   2) 独立生产服务器（server/index.mjs，ModelScope 创空间用）
// 使用，避免两套代理逻辑漂移。
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MODEL_CATALOG } from "../src/lib/providers.js";
import { loadDotEnv, projectRoot } from "./env.mjs";
import { clientKey, createDailyBudget, createSlidingWindowLimiter } from "./quota.mjs";

loadDotEnv();

const numberFromEnv = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
};

const MAX_BODY_BYTES = numberFromEnv("MAX_BODY_BYTES", 12 * 1024 * 1024);
const EDGE_TTS_SCRIPT = process.env.EDGE_TTS_SCRIPT || path.join(projectRoot, "scripts", "edge_tts_speak.py");
const EDGE_TTS_TIMEOUT_MS = numberFromEnv("EDGE_TTS_TIMEOUT_MS", 30000);
const EDGE_TTS_CACHE_MAX = 40;
const EDGE_TTS_MAX_CONCURRENCY = 2;
// 逗号分隔的候选解释器：谁先能 import edge_tts 就用谁。容器里是 python3，Windows 本地通常是 python。
const EDGE_TTS_PYTHON_CANDIDATES = String(process.env.EDGE_TTS_PYTHON || "python3,python,py")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

// 站点托管额度：为空表示"访客必须自带 Key"，社区访客可用 POST /api/llm 时留空 apiKey 走这里。
const HOSTED_LLM_TOKEN = String(process.env.HOSTED_LLM_TOKEN || process.env.MODELSCOPE_API_TOKEN || "").trim();
const HOSTED_LLM_BASE_URL = process.env.HOSTED_LLM_BASE_URL || "https://api-inference.modelscope.cn/v1";
const HOSTED_LLM_MODEL = process.env.HOSTED_LLM_MODEL || "Qwen/Qwen3-8B";
const HOSTED_LLM_MAX_TOKENS = numberFromEnv("HOSTED_LLM_MAX_TOKENS", 1200);
const LLM_REQUESTS_PER_MINUTE = numberFromEnv("LLM_REQUESTS_PER_MINUTE", 20);
const HOSTED_REQUESTS_PER_IP_PER_DAY = numberFromEnv("HOSTED_REQUESTS_PER_IP_PER_DAY", 40);
const HOSTED_REQUESTS_PER_DAY = numberFromEnv("HOSTED_REQUESTS_PER_DAY", 800);
const TTS_REQUESTS_PER_MINUTE = numberFromEnv("TTS_REQUESTS_PER_MINUTE", 30);

const llmLimiter = createSlidingWindowLimiter({ windowMs: 60_000, max: LLM_REQUESTS_PER_MINUTE });
const ttsLimiter = createSlidingWindowLimiter({ windowMs: 60_000, max: TTS_REQUESTS_PER_MINUTE });
const hostedGlobalBudget = createDailyBudget({ max: HOSTED_REQUESTS_PER_DAY });
const hostedPerIpBudget = createDailyBudget({ max: HOSTED_REQUESTS_PER_IP_PER_DAY });

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
try {
  if (HOSTED_LLM_TOKEN) ALLOWED_MODEL_HOSTS.add(new URL(HOSTED_LLM_BASE_URL).hostname);
} catch {
  // 托管 Base URL 不合法时忽略，稍后使用时会被白名单拦下
}
const ALLOW_LOCAL_MODEL_HOST = process.env.ALLOW_LOCAL_MODEL_HOST === "1";

export function resolveUpstreamUrl(raw) {
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

class HttpError extends Error {
  constructor(statusCode, message, code) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

async function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new HttpError(413, `请求体超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限`, "payload_too_large");
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function sendJson(res, statusCode, payload, code) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(code ? { ...payload, code } : payload));
}

function fail(res, err, fallbackStatus, fallbackCode) {
  if (res.writableEnded || res.destroyed) return;
  if (err instanceof HttpError) {
    sendJson(res, err.statusCode, { error: err.message }, err.code);
    return;
  }
  sendJson(res, fallbackStatus, { error: err.message || String(err) }, fallbackCode);
}

// ---------- Edge TTS ----------
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

function runProbe(python) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(python, ["-c", "import edge_tts"], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    } catch (err) {
      resolve({ ok: false, detail: err.message });
      return;
    }
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      finish({ ok: false, detail: "探测超时" });
    }, 8000);
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-400);
    });
    child.on("error", (err) => finish({ ok: false, detail: err.message }));
    child.on("close", (code) => finish(code === 0 ? { ok: true } : { ok: false, detail: stderr.trim() || `退出码 ${code}` }));
  });
}

let ttsProbePromise = null;
async function detectTts() {
  if (!fs.existsSync(EDGE_TTS_SCRIPT)) {
    return { available: false, python: "", reason: `未找到 TTS 脚本 ${EDGE_TTS_SCRIPT}` };
  }
  const failures = [];
  for (const candidate of EDGE_TTS_PYTHON_CANDIDATES) {
    const result = await runProbe(candidate);
    if (result.ok) return { available: true, python: candidate, reason: "" };
    failures.push(`${candidate}（${result.detail}）`);
  }
  return {
    available: false,
    python: "",
    reason: `没有可用的 Python + edge-tts：${failures.join("、")}。可设置 EDGE_TTS_PYTHON 指定解释器。`
  };
}

export function ttsStatus() {
  if (!ttsProbePromise) ttsProbePromise = detectTts();
  return ttsProbePromise;
}

// 异步拉起 TTS 子进程：不阻塞事件循环。
function runTtsProcess(python, payloadFile, output) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [EDGE_TTS_SCRIPT, payloadFile], {
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

// ---------- 各接口 ----------
async function handleLlm(req, res) {
  try {
    const payload = await readJsonBody(req);
    const { messages, maxTokens, temperature } = payload;
    let { baseUrl, apiKey, model } = payload;
    if (!Array.isArray(messages)) {
      throw new HttpError(400, "messages 不能为空", "bad_request");
    }
    const usingHosted = !String(apiKey || "").trim();
    if (usingHosted) {
      if (!HOSTED_LLM_TOKEN) {
        throw new HttpError(400, "未配置 API Key", "api_key_required");
      }
      const perIp = hostedPerIpBudget.take();
      if (!perIp.ok) {
        throw new HttpError(429, "今日免费体验额度已用完，请填写自己的 API Key 继续练习。", "hosted_quota_exceeded");
      }
      const global = hostedGlobalBudget.take();
      if (!global.ok) {
        throw new HttpError(429, "站点今日共享额度已用尽，请填写自己的 API Key 继续练习。", "hosted_quota_exceeded");
      }
      baseUrl = HOSTED_LLM_BASE_URL;
      model = HOSTED_LLM_MODEL;
      apiKey = HOSTED_LLM_TOKEN;
    }
    if (!baseUrl || !model) {
      throw new HttpError(400, "baseUrl / model 不能为空", "bad_request");
    }
    const limit = llmLimiter.take(clientKey(req));
    if (!limit.ok) {
      throw new HttpError(429, "请求过于频繁，请稍后再试。", "rate_limited");
    }
    const target = resolveUpstreamUrl(baseUrl);
    if (!target.ok) {
      throw new HttpError(400, target.error, "base_url_not_allowed");
    }
    const tokenCap = usingHosted ? Math.min(HOSTED_LLM_MAX_TOKENS, 8192) : 8192;
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
          max_tokens: clampNumber(maxTokens, 1200, 16, tokenCap),
          stream: false
        }),
        signal: controller.signal
      });
    } catch (err) {
      if (controller.signal.aborted) {
        if (!res.writableEnded && !res.destroyed) {
          sendJson(res, 499, { error: "客户端已取消请求" }, "client_aborted");
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
      throw new HttpError(502, `模型接口返回 ${upstream.status}: ${detail}`, "upstream_error");
    }
    const text = data?.choices?.[0]?.message?.content;
    if (!text) {
      sendJson(res, 502, { error: "模型没有返回内容", detail: data }, "empty_completion");
      return;
    }
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ text, hosted: usingHosted }));
  } catch (err) {
    fail(res, err, 500, "llm_failed");
  }
}

async function handleResumeParse(req, res) {
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
    sendJson(res, 200, { text: clean, chars: clean.length });
  } catch (err) {
    fail(res, err, 400, "resume_parse_failed");
  }
}

async function handleEdgeTts(req, res) {
  try {
    const status = await ttsStatus();
    if (!status.available) {
      throw new HttpError(503, `本机未启用自然语音合成：${status.reason}`, "tts_unavailable");
    }
    const limit = ttsLimiter.take(clientKey(req));
    if (!limit.ok) {
      throw new HttpError(429, "语音合成请求过于频繁，请稍后再试。", "rate_limited");
    }
    const payload = await readJsonBody(req);
    const { text = "", voice = "zh-CN-XiaoxiaoNeural", rate = "+4%", pitch = "+0Hz" } = payload;
    if (!String(text).trim()) {
      throw new HttpError(400, "text 不能为空", "bad_request");
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
    fs.writeFileSync(payloadFile, JSON.stringify({ text: safeText, voice, rate, pitch, output }), "utf8");
    try {
      await withTtsSlot(() => runTtsProcess(status.python, payloadFile, output));
    } catch (err) {
      throw new HttpError(502, `Edge TTS 生成失败: ${String(err.message || err).slice(0, 500)}`, "tts_failed");
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
    fail(res, err, 500, "tts_failed");
  }
}

async function handleHealth(req, res) {
  const tts = await ttsStatus();
  sendJson(res, 200, {
    ok: true,
    tts: { available: tts.available, reason: tts.reason },
    hostedLlm: {
      enabled: Boolean(HOSTED_LLM_TOKEN),
      model: HOSTED_LLM_TOKEN ? HOSTED_LLM_MODEL : "",
      perIpPerDay: HOSTED_LLM_TOKEN ? HOSTED_REQUESTS_PER_IP_PER_DAY : 0
    },
    limits: { maxBodyBytes: MAX_BODY_BYTES, llmPerMinute: LLM_REQUESTS_PER_MINUTE }
  });
}

export function createApiHandlers() {
  return {
    "/api/llm": handleLlm,
    "/api/parse-resume": handleResumeParse,
    "/api/edge-tts": handleEdgeTts,
    "/api/health": handleHealth
  };
}

// 启动后台探测一次 TTS，避免首个访客承担探测延迟。
export function warmup() {
  ttsStatus().catch(() => {});
}
