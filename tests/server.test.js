import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clientKey, createDailyBudget, createSlidingWindowLimiter } from "../server/quota.mjs";
import { createApiHandlers, resolveUpstreamUrl } from "../server/api.mjs";

function createReq(payload, { headers = {}, method = "POST", url = "/api/llm" } = {}) {
  const body = Buffer.from(JSON.stringify(payload ?? {}), "utf8");
  return {
    method,
    url,
    headers,
    socket: { remoteAddress: "10.0.0.9" },
    [Symbol.asyncIterator]() {
      let sent = false;
      return {
        next() {
          if (sent) return Promise.resolve({ done: true, value: undefined });
          sent = true;
          return Promise.resolve({ done: false, value: body });
        }
      };
    }
  };
}

function createRes() {
  const emitter = new EventEmitter();
  const res = {
    statusCode: 200,
    headers: {},
    body: "",
    writableEnded: false,
    destroyed: false,
    setHeader(name, value) {
      res.headers[name.toLowerCase()] = value;
    },
    writeHead(statusCode, headers) {
      res.statusCode = statusCode;
      Object.entries(headers || {}).forEach(([name, value]) => res.setHeader(name, value));
      return res;
    },
    end(chunk) {
      if (chunk !== undefined) res.body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      res.writableEnded = true;
    },
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    emit: emitter.emit.bind(emitter)
  };
  return res;
}

// 音频走原始二进制 body，所以单独造一个请求对象。
function createBinaryReq(buffer, { contentType = "audio/webm", url = "/api/asr?lang=zh" } = {}) {
  return {
    method: "POST",
    url,
    headers: { "content-type": contentType },
    socket: { remoteAddress: "10.0.0.9" },
    [Symbol.asyncIterator]() {
      let sent = false;
      return {
        next() {
          if (sent) return Promise.resolve({ done: true, value: undefined });
          sent = true;
          return Promise.resolve({ done: false, value: buffer });
        }
      };
    }
  };
}

async function callRoute(path, payload, options) {
  const routes = createApiHandlers();
  const res = createRes();
  await routes[path](createReq(payload, options), res);
  let json = null;
  try {
    json = JSON.parse(res.body);
  } catch {
    json = null;
  }
  return { res, json };
}

describe("resolveUpstreamUrl", () => {
  it("allows catalog hosts and appends the chat completions path", () => {
    const target = resolveUpstreamUrl("https://api-inference.modelscope.cn/v1");
    expect(target.ok).toBe(true);
    expect(target.url).toBe("https://api-inference.modelscope.cn/v1/chat/completions");
  });

  it("keeps a full completions URL untouched", () => {
    expect(resolveUpstreamUrl("https://api.deepseek.com/v1/chat/completions").url).toBe(
      "https://api.deepseek.com/v1/chat/completions"
    );
  });

  it("rejects hosts outside the allow list", () => {
    const target = resolveUpstreamUrl("https://evil.example.com/v1");
    expect(target.ok).toBe(false);
    expect(target.error).toContain("白名单");
  });
});

describe("quota helpers", () => {
  it("blocks after the sliding window is exhausted and recovers later", () => {
    const limiter = createSlidingWindowLimiter({ windowMs: 1000, max: 2 });
    expect(limiter.take("a").ok).toBe(true);
    expect(limiter.take("a").ok).toBe(true);
    const blocked = limiter.take("a");
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
    expect(limiter.take("b").ok).toBe(true);
  });

  it("stops the daily budget at max and treats 0 as unlimited", () => {
    const budget = createDailyBudget({ max: 2 });
    expect(budget.take().ok).toBe(true);
    expect(budget.take().ok).toBe(true);
    expect(budget.take().ok).toBe(false);
    const unlimited = createDailyBudget({ max: 0 });
    for (let i = 0; i < 5; i += 1) expect(unlimited.take().ok).toBe(true);
  });

  it("prefers the forwarded client address when present", () => {
    expect(clientKey({ headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" }, socket: { remoteAddress: "10.0.0.1" } })).toBe("1.2.3.4");
    expect(clientKey({ headers: {}, socket: { remoteAddress: "10.0.0.1" } })).toBe("10.0.0.1");
  });
});

describe("api routes", () => {
  it("registers llm, resume, tts and health endpoints", () => {
    expect(Object.keys(createApiHandlers()).sort()).toEqual(
      ["/api/asr", "/api/edge-tts", "/api/health", "/api/llm", "/api/parse-resume"].sort()
    );
  });

  it("reports capabilities on /api/health", async () => {
    const { res, json } = await callRoute("/api/health", {}, { method: "POST" });
    expect(res.statusCode).toBe(200);
    expect(json.ok).toBe(true);
    expect(typeof json.tts.available).toBe("boolean");
    expect(json.hostedLlm.enabled).toBe(false);
  });

  it("asks for a key when no hosted token is configured", async () => {
    const { res, json } = await callRoute("/api/llm", { model: "gpt-4o-mini", messages: [] });
    expect(res.statusCode).toBe(400);
    expect(json.code).toBe("api_key_required");
  });

  it("rejects empty messages before touching the network", async () => {
    const { res, json } = await callRoute("/api/llm", { apiKey: "sk-x", baseUrl: "https://api.deepseek.com", model: "deepseek-chat" });
    expect(res.statusCode).toBe(400);
    expect(json.code).toBe("bad_request");
  });

  it("blocks oversized request bodies", async () => {
    const routes = createApiHandlers();
    const res = createRes();
    const huge = { apiKey: "sk-x", baseUrl: "https://api.deepseek.com", model: "deepseek-chat", messages: [], padding: "x".repeat(13 * 1024 * 1024) };
    await routes["/api/llm"](createReq(huge), res);
    expect(res.statusCode).toBe(413);
  });
});

describe("server side asr", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("ASR_BASE_URL", "");
    vi.stubEnv("ASR_MODEL", "");
    vi.stubEnv("ASR_TOKEN", "");
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("reports unavailable and refuses work when nothing is configured", async () => {
    vi.stubEnv("ASR_BASE_URL", "");
    vi.stubEnv("ASR_MODEL", "");
    vi.stubEnv("ASR_TOKEN", "");
    vi.resetModules();
    const mod = await import("../server/api.mjs");
    const res = createRes();
    await mod.createApiHandlers()["/api/asr"](createBinaryReq(Buffer.from("audio-bytes")), res);
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).code).toBe("asr_unavailable");
    const health = await callRoute("/api/health", {}, { method: "POST" });
    expect(health.json.asr.available).toBe(false);
    expect(health.json.asr.reason).toContain("ASR_BASE_URL");
  });

  it("forwards the audio as multipart to the configured upstream", async () => {
    vi.stubEnv("ASR_BASE_URL", "https://asr.example.com/v1");
    vi.stubEnv("ASR_MODEL", "sense-voice");
    vi.stubEnv("ASR_TOKEN", "asr-token");
    vi.resetModules();
    const captured = [];
    vi.stubGlobal("fetch", async (url, init) => {
      captured.push({ url, init });
      return { ok: true, status: 200, statusText: "OK", text: async () => JSON.stringify({ text: "我负责过电商中台项目" }) };
    });
    const mod = await import("../server/api.mjs");
    const audio = Buffer.from("fake-webm-audio-bytes");
    const res = createRes();
    await mod.createApiHandlers()["/api/asr"](createBinaryReq(audio, { contentType: "audio/webm" }), res);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ text: "我负责过电商中台项目", engine: "server" });
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe("https://asr.example.com/v1/audio/transcriptions");
    expect(captured[0].init.headers.Authorization).toBe("Bearer asr-token");
    const form = captured[0].init.body;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("model")).toBe("sense-voice");
    expect(form.get("language")).toBe("zh");
    const file = form.get("file");
    expect(file.size).toBe(audio.length);
    expect(file.type).toBe("audio/webm");
  });

  it("rejects non audio payloads and oversized audio", async () => {
    vi.stubEnv("ASR_BASE_URL", "https://asr.example.com/v1");
    vi.stubEnv("ASR_MODEL", "sense-voice");
    vi.stubEnv("ASR_TOKEN", "asr-token");
    vi.resetModules();
    vi.stubGlobal("fetch", async () => ({ ok: true, status: 200, statusText: "OK", text: async () => '{"text":"x"}' }));
    const mod = await import("../server/api.mjs");
    const routes = mod.createApiHandlers();

    const bad = createRes();
    await routes["/api/asr"](createBinaryReq(Buffer.from("hi"), { contentType: "application/json" }), bad);
    expect(bad.statusCode).toBe(415);

    const huge = createRes();
    await routes["/api/asr"](createBinaryReq(Buffer.alloc(9 * 1024 * 1024)), huge);
    expect(huge.statusCode).toBe(413);
  });

  it("surfaces upstream failures as a readable error", async () => {
    vi.stubEnv("ASR_BASE_URL", "https://asr.example.com/v1");
    vi.stubEnv("ASR_MODEL", "sense-voice");
    vi.stubEnv("ASR_TOKEN", "asr-token");
    vi.resetModules();
    vi.stubGlobal("fetch", async () => ({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: async () => JSON.stringify({ error: { message: "invalid token" } })
    }));
    const mod = await import("../server/api.mjs");
    const res = createRes();
    await mod.createApiHandlers()["/api/asr"](createBinaryReq(Buffer.from("audio")), res);
    expect(res.statusCode).toBe(502);
    const body = JSON.parse(res.body);
    expect(body.code).toBe("asr_upstream_error");
    expect(body.error).toContain("invalid token");
  });
});

describe("hosted token mode", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("injects the server token and pins the hosted model", async () => {
    vi.stubEnv("HOSTED_LLM_TOKEN", "ms-hosted-token");
    vi.stubEnv("HOSTED_LLM_BASE_URL", "https://api-inference.modelscope.cn/v1");
    vi.stubEnv("HOSTED_LLM_MODEL", "Qwen/Qwen3-8B");
    vi.resetModules();
    const captured = [];
    vi.stubGlobal("fetch", async (url, init) => {
      captured.push({ url, init });
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => JSON.stringify({ choices: [{ message: { content: "你好" } }] })
      };
    });
    const mod = await import("../server/api.mjs");
    const res = createRes();
    await mod.createApiHandlers()["/api/llm"](
      createReq({ messages: [{ role: "user", content: "hi" }], model: "任意", baseUrl: "https://api.openai.com/v1", maxTokens: 99999 }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).hosted).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe("https://api-inference.modelscope.cn/v1/chat/completions");
    expect(captured[0].init.headers.Authorization).toBe("Bearer ms-hosted-token");
    const sent = JSON.parse(captured[0].init.body);
    expect(sent.model).toBe("Qwen/Qwen3-8B");
    expect(sent.max_tokens).toBeLessThanOrEqual(1200);
  });
});
