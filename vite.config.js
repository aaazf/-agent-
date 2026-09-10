import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const EDGE_PYTHON =
  process.env.EDGE_TTS_PYTHON ||
  "C:/Users/xx/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe";
const EDGE_TTS_SCRIPT = path.join(projectRoot, "scripts", "edge_tts_speak.py");

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
      const { baseUrl, apiKey, model, messages } = payload;
      if (!baseUrl || !apiKey || !model || !Array.isArray(messages)) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "baseUrl / apiKey / model / messages 不能为空" }));
        return;
      }
      const cleanBase = String(baseUrl).trim().replace(/\/+$/, "");
      const upstreamUrl = cleanBase.endsWith("/chat/completions")
        ? cleanBase
        : `${cleanBase}/chat/completions`;
      const upstream = await fetch(upstreamUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${String(apiKey).trim()}`
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.75,
          stream: false
        })
      });
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
      const output = path.join(os.tmpdir(), `edge-tts-${Date.now()}-${Math.random().toString(16).slice(2)}.mp3`);
      const payloadFile = output.replace(/\.mp3$/, ".json");
      fs.writeFileSync(
        payloadFile,
        JSON.stringify({
          text: String(text).slice(0, 2500),
          voice,
          rate,
          pitch,
          output
        }),
        "utf8"
      );
      const result = spawnSync(
        EDGE_PYTHON,
        [EDGE_TTS_SCRIPT, payloadFile],
        {
          encoding: "utf8",
          timeout: 30000,
          windowsHide: true
        }
      );
      try {
        fs.unlinkSync(payloadFile);
      } catch {
        // temp cleanup
      }
      if (result.status !== 0 || !fs.existsSync(output)) {
        const detail = String(result.stderr || result.error || "edge-tts failed").slice(0, 500);
        res.statusCode = 502;
        res.end(JSON.stringify({ error: `Edge TTS 生成失败: ${detail}` }));
        return;
      }
      const audio = fs.readFileSync(output);
      try {
        fs.unlinkSync(output);
      } catch {
        // temp cleanup best effort
      }
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
  }
});
