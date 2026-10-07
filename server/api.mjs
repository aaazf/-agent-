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
import { ACCOUNT_ROUTE_METHODS, createAccountHandlers, signupStatus } from "./account-routes.mjs";
import { ASR_CONFIG, asrStatus, transcribeAudio } from "./asr.mjs";
import { hashToken, readAuthToken } from "./auth.mjs";
import { loadDotEnv, projectRoot } from "./env.mjs";
import { HttpError, MAX_BODY_BYTES, fail, numberFromEnv, readBinaryBody, readJsonBody, sendJson } from "./http.mjs";
import { clientKey, createDailyBudget, createKeyedDailyBudget, createSlidingWindowLimiter } from "./quota.mjs";
import { getStore } from "./store.mjs";

loadDotEnv();

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
// 默认上游与默认模型直接取自 providers.js 的模型目录：文档、前端选择器、服务端托管额度
// 三处共用一个来源，避免上游清单变化时模型名漂移（旧默认 Qwen/Qwen3-8B 已下架，
// 部署后会直接报"模型不存在"，属于最难自查的一类故障）。
const MODELSCOPE_CATALOG = MODEL_CATALOG["魔搭 ModelScope"];
const HOSTED_LLM_BASE_URL = process.env.HOSTED_LLM_BASE_URL || MODELSCOPE_CATALOG.baseUrl;
const HOSTED_LLM_MODEL = process.env.HOSTED_LLM_MODEL || MODELSCOPE_CATALOG.models[0];
const HOSTED_LLM_MAX_TOKENS = numberFromEnv("HOSTED_LLM_MAX_TOKENS", 1200);
const LLM_REQUESTS_PER_MINUTE = numberFromEnv("LLM_REQUESTS_PER_MINUTE", 20);
const HOSTED_REQUESTS_PER_IP_PER_DAY = numberFromEnv("HOSTED_REQUESTS_PER_IP_PER_DAY", 40);
const HOSTED_REQUESTS_PER_DAY = numberFromEnv("HOSTED_REQUESTS_PER_DAY", 800);
const TTS_REQUESTS_PER_MINUTE = numberFromEnv("TTS_REQUESTS_PER_MINUTE", 30);
const ASR_REQUESTS_PER_MINUTE = numberFromEnv("ASR_REQUESTS_PER_MINUTE", 20);
const ASR_REQUESTS_PER_DAY = numberFromEnv("ASR_REQUESTS_PER_DAY", 600);

const llmLimiter = createSlidingWindowLimiter({ windowMs: 60_000, max: LLM_REQUESTS_PER_MINUTE });
const ttsLimiter = createSlidingWindowLimiter({ windowMs: 60_000, max: TTS_REQUESTS_PER_MINUTE });
const asrLimiter = createSlidingWindowLimiter({ windowMs: 60_000, max: ASR_REQUESTS_PER_MINUTE });
const asrDailyBudget = createDailyBudget({ max: ASR_REQUESTS_PER_DAY });
const hostedGlobalBudget = createDailyBudget({ max: HOSTED_REQUESTS_PER_DAY });
// 必须按访客分别计数：这里原来误用全局计数器，等于全站共用一个"每人每日"额度池，
// 一个人面完几场就把所有社区访客挡在门外。
const hostedPerIpBudget = createKeyedDailyBudget({ max: HOSTED_REQUESTS_PER_IP_PER_DAY });

// 路由层共用的存储单例。默认走 getStore()；只有测试会显式注入临时存储，
// 避免单测把账号写进仓库里的 data/。
let activeStore = null;
function storeRef() {
  return activeStore || getStore();
}

// 共享额度的计数键：已登录按账号计，未登录退回按 IP 计。
// 同一间宿舍/公司出口 IP 后面可能坐着十几个访客，按 IP 计数会让彼此互相挤掉额度；
// 而按账号计数也顺手把"注册一个新号就重置额度"限制在注册名额（SIGNUPS_PER_DAY）之内。
function hostedQuotaKey(req) {
  const token = readAuthToken(req);
  if (token) {
    const session = storeRef().sessions.byTokenHash(hashToken(token));
    if (session) return `user:${session.userId}`;
  }
  return `ip:${clientKey(req)}`;
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
      const perIp = hostedPerIpBudget.take(hostedQuotaKey(req));
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

async function handleAsr(req, res) {
  try {
    const status = asrStatus();
    if (!status.available) {
      throw new HttpError(503, `服务端未启用语音识别：${status.reason}`, "asr_unavailable");
    }
    const limit = asrLimiter.take(clientKey(req));
    if (!limit.ok) {
      throw new HttpError(429, "语音识别请求过于频繁，请稍后再试。", "rate_limited");
    }
    const budget = asrDailyBudget.take();
    if (!budget.ok) {
      throw new HttpError(429, "站点今日语音识别额度已用尽，请改用文字回答。", "asr_quota_exceeded");
    }
    const contentType = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase() || "audio/webm";
    if (!contentType.startsWith("audio/") && contentType !== "application/octet-stream") {
      throw new HttpError(415, `不支持的音频类型：${contentType}`, "unsupported_media_type");
    }
    const buffer = await readBinaryBody(req, ASR_CONFIG.maxBytes);
    let language = ASR_CONFIG.language;
    try {
      language = new URL(req.url || "/api/asr", "http://localhost").searchParams.get("lang") || language;
    } catch {
      // 参数解析失败时沿用默认语言
    }
    const text = await transcribeAudio({ buffer, contentType, language });
    sendJson(res, 200, { text, engine: "server" });
  } catch (err) {
    fail(res, err, 502, "asr_failed");
  }
}

// 上游模型清单探测：只在显式 /api/health?deep=1 时触发，结果缓存一段时间。
// 托管模型名和上游清单对不上时，访客拿到的是模型报错而不是降级提示，
// 这是部署后最难自查的一类故障，所以给部署方留一个可远程调用的深检入口。
let modelCatalogCache = { at: 0, ids: null };

// 候选清单排序：同名组织的模型排在前面。模型改名多数时候只是换了版本号，
// 把 Qwen/* 排在 deepseek-ai/* 前面，部署方一眼就能找到该换成哪个。
function rankModelCandidates(ids, model) {
  const org = String(model).split("/")[0];
  const sameOrg = ids.filter((id) => id.startsWith(`${org}/`));
  const rest = ids.filter((id) => !id.startsWith(`${org}/`));
  return [...sameOrg, ...rest].slice(0, 30);
}

async function probeHostedModelIds() {
  const ttl = numberFromEnv("MODEL_CATALOG_TTL_MS", 5 * 60 * 1000);
  if (modelCatalogCache.ids && Date.now() - modelCatalogCache.at < ttl) return modelCatalogCache.ids;
  const res = await fetch(`${String(HOSTED_LLM_BASE_URL).replace(/\/+$/, "")}/models`, {
    headers: { Authorization: `Bearer ${HOSTED_LLM_TOKEN}` },
    signal: AbortSignal.timeout(numberFromEnv("MODEL_CATALOG_TIMEOUT_MS", 8000))
  });
  if (!res.ok) throw new Error(`上游 /models 返回 ${res.status}`);
  const data = await res.json();
  const ids = (data?.data || []).map((item) => String(item?.id || "")).filter(Boolean);
  modelCatalogCache = { at: Date.now(), ids };
  return ids;
}

async function handleHealth(req, res) {
  const tts = await ttsStatus();
  const storeStatus = storeRef().status();
  const payload = {
    ok: true,
    tts: { available: tts.available, reason: tts.reason },
    asr: asrStatus(),
    // 账号体系是否可用、数据落在哪：部署方最需要知道"重启后账号还在不在"。
    // persistent=false 时创空间的账号数据会在容器重启后丢失，前端要据此提示访客。
    accounts: {
      ...signupStatus(),
      persistent: storeStatus.persistent,
      reason: storeStatus.reason,
      users: storeStatus.users,
      resumes: storeStatus.resumes
    },
    hostedLlm: {
      enabled: Boolean(HOSTED_LLM_TOKEN),
      model: HOSTED_LLM_TOKEN ? HOSTED_LLM_MODEL : "",
      perIpPerDay: HOSTED_LLM_TOKEN ? HOSTED_REQUESTS_PER_IP_PER_DAY : 0,
      // 运营视角：全站额度还剩多少。公开部署最怕"额度悄悄用尽、访客全部被拒"，
      // 这里只暴露计数，不含任何访客标识。
      dailyBudget: HOSTED_LLM_TOKEN ? hostedGlobalBudget.snapshot() : null
    },
    limits: {
      maxBodyBytes: MAX_BODY_BYTES,
      llmPerMinute: LLM_REQUESTS_PER_MINUTE,
      asrPerMinute: ASR_REQUESTS_PER_MINUTE,
      asrPerDay: ASR_REQUESTS_PER_DAY
    }
  };
  // 默认不发起外部请求，保持 /api/health 轻快；只有显式 ?deep=1 才去核对上游清单。
  const deep = /(?:^|[?&])deep=1(?:&|$)/.test(String(req?.url || ""));
  if (deep && HOSTED_LLM_TOKEN) {
    try {
      const ids = await probeHostedModelIds();
      payload.hostedLlm.modelAvailable = ids.includes(HOSTED_LLM_MODEL);
      if (!payload.hostedLlm.modelAvailable) {
        payload.hostedLlm.availableModels = rankModelCandidates(ids, HOSTED_LLM_MODEL);
      }
    } catch (err) {
      payload.hostedLlm.modelAvailable = null;
      payload.hostedLlm.probeError = err?.message || String(err);
    }
  }
  sendJson(res, 200, payload);
}

// 每个路由允许的 HTTP 方法：默认只允许 POST（沿用原有约定），
// 读取类接口（会话自检、简历列表、数据导出）单独放开 GET。
export const API_ROUTE_METHODS = { ...ACCOUNT_ROUTE_METHODS };

export function createApiHandlers({ store = null } = {}) {
  activeStore = store;
  return {
    "/api/llm": handleLlm,
    "/api/parse-resume": handleResumeParse,
    "/api/edge-tts": handleEdgeTts,
    "/api/asr": handleAsr,
    "/api/health": handleHealth,
    ...createAccountHandlers({ store })
  };
}

// 启动后台探测一次 TTS，避免首个访客承担探测延迟。
export function warmup() {
  ttsStatus().catch(() => {});
}
