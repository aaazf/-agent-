// 服务端语音识别：把浏览器录到的音频转发给 OpenAI 兼容的 /audio/transcriptions 接口。
// 与 LLM 一样由部署方持有 Token，访客不需要自带 Key —— 这是创空间里社区能用语音作答的前提，
// 也让语音链路摆脱「必须 Chromium + 必须能访问 Google」的限制。
import { loadDotEnv } from "./env.mjs";

loadDotEnv();

const numberFromEnv = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
};

const trim = (value) => String(value || "").trim();

function resolveBaseUrl() {
  return trim(process.env.ASR_BASE_URL || process.env.HOSTED_LLM_BASE_URL).replace(/\/+$/, "");
}

export const ASR_CONFIG = {
  provider: trim(process.env.ASR_PROVIDER).toLowerCase(),
  baseUrl: resolveBaseUrl(),
  model: trim(process.env.ASR_MODEL),
  token: trim(process.env.ASR_TOKEN || process.env.HOSTED_LLM_TOKEN || process.env.MODELSCOPE_API_TOKEN),
  language: trim(process.env.ASR_LANGUAGE) || "zh",
  timeoutMs: numberFromEnv("ASR_TIMEOUT_MS", 45000),
  maxBytes: numberFromEnv("ASR_MAX_BYTES", 8 * 1024 * 1024)
};

export function asrStatus() {
  if (ASR_CONFIG.provider === "off") {
    return { available: false, model: "", reason: "ASR_PROVIDER=off，已显式关闭服务端语音识别" };
  }
  const missing = [];
  if (!ASR_CONFIG.baseUrl) missing.push("ASR_BASE_URL");
  if (!ASR_CONFIG.model) missing.push("ASR_MODEL");
  if (!ASR_CONFIG.token) missing.push("ASR_TOKEN");
  if (missing.length) {
    return { available: false, model: "", reason: `缺少配置：${missing.join(" / ")}` };
  }
  return { available: true, model: ASR_CONFIG.model, reason: "" };
}

export function asrAvailable() {
  return asrStatus().available;
}

const EXTENSION_BY_TYPE = [
  [/ogg/i, "answer.ogg"],
  [/mp4|m4a|aac/i, "answer.mp4"],
  [/wav|x-wav/i, "answer.wav"],
  [/mpeg|mp3/i, "answer.mp3"],
  [/webm/i, "answer.webm"]
];

function fileNameFor(contentType) {
  const match = EXTENSION_BY_TYPE.find(([pattern]) => pattern.test(contentType));
  return match ? match[1] : "answer.webm";
}

// 把音频转成文字；失败时抛出带可读信息的 Error。
export async function transcribeAudio({ buffer, contentType = "audio/webm", language } = {}) {
  const status = asrStatus();
  if (!status.available) {
    const err = new Error(`服务端未启用语音识别：${status.reason}`);
    err.code = "asr_unavailable";
    throw err;
  }
  if (!buffer || !buffer.length) {
    const err = new Error("音频内容为空");
    err.code = "bad_request";
    throw err;
  }

  const form = new FormData();
  form.append("file", new Blob([buffer], { type: contentType }), fileNameFor(contentType));
  form.append("model", ASR_CONFIG.model);
  const lang = trim(language) || ASR_CONFIG.language;
  if (lang) form.append("language", lang);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ASR_CONFIG.timeoutMs);
  let upstream;
  try {
    upstream = await fetch(`${ASR_CONFIG.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ASR_CONFIG.token}` },
      body: form,
      signal: controller.signal
    });
  } catch (err) {
    clearTimeout(timer);
    if (controller.signal.aborted) {
      const timeoutErr = new Error(`语音识别超时（>${ASR_CONFIG.timeoutMs}ms）`);
      timeoutErr.code = "asr_timeout";
      throw timeoutErr;
    }
    const netErr = new Error(`语音识别上游不可达：${err.message || err}`);
    netErr.code = "asr_upstream_error";
    throw netErr;
  }
  clearTimeout(timer);

  const raw = await upstream.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    data = { raw };
  }

  if (!upstream.ok) {
    const detail = data?.error?.message || data?.message || data?.raw || upstream.statusText;
    const err = new Error(`语音识别接口返回 ${upstream.status}: ${String(detail).slice(0, 300)}`);
    err.code = "asr_upstream_error";
    throw err;
  }

  const text = String(data?.text ?? data?.result ?? data?.data?.text ?? "").trim();
  if (!text) {
    const err = new Error("语音识别没有返回文字");
    err.code = "asr_empty";
    throw err;
  }
  return text;
}