// 路由层共用的 HTTP 小工具：从 api.mjs 抽出来，供账号/简历路由共用，
// 避免"两套 JSON body 解析"这种日后一定会漂移的重复实现。
import { loadDotEnv } from "./env.mjs";

loadDotEnv();

export function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

export const MAX_BODY_BYTES = numberFromEnv("MAX_BODY_BYTES", 12 * 1024 * 1024);

// 路由内部用 HttpError 表达"这条请求该回什么状态码"，
// 统一由 fail() 落成响应，避免每个 handler 各自 try/catch 拼错误格式。
export class HttpError extends Error {
  constructor(statusCode, message, code) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export async function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new HttpError(413, `请求体超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限`, "payload_too_large");
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, "请求体不是合法 JSON", "bad_request");
  }
}

// 音频以原始二进制上传（而不是 multipart），前端只要把 Blob 直接当 body 发过来即可。
export async function readBinaryBody(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new HttpError(413, `音频超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限`, "payload_too_large");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function sendJson(res, statusCode, payload, code) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(code ? { ...payload, code } : payload));
}

export function fail(res, err, fallbackStatus, fallbackCode) {
  if (res.writableEnded || res.destroyed) return;
  if (err instanceof HttpError) {
    sendJson(res, err.statusCode, { error: err.message }, err.code);
    return;
  }
  // 上游/底层模块可能自带更精确的 code（如 asr_upstream_error），优先透出便于前端分流。
  sendJson(res, fallbackStatus, { error: err.message || String(err) }, err.code || fallbackCode);
}
