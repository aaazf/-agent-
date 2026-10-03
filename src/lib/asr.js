// 前端调用服务端语音识别：把录音 Blob 直接作为请求体上传，服务器再转成 multipart 发给 ASR 上游。
// 走服务端的好处：访客不需要自带 Key，也不依赖浏览器内置的语音服务（Chrome 之外也能用，国内可直连）。
import { ASR_LANG } from "./language.js";

export async function transcribeAudio(blob, { language = ASR_LANG, timeoutMs = 60000 } = {}) {
  if (!blob || !blob.size) {
    throw new Error("没有录到音频，请靠近麦克风再说一次。");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`/api/asr?lang=${encodeURIComponent(language)}`, {
      method: "POST",
      headers: { "Content-Type": blob.type || "audio/webm" },
      body: blob,
      signal: controller.signal
    });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(
      err?.name === "AbortError"
        ? "语音识别超时，可以先改用文字回答这一题。"
        : `语音识别请求失败：${err.message || err}`
    );
  }
  clearTimeout(timer);

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (data?.code === "asr_unavailable") {
      throw new Error("本站未开启服务端语音识别，请改用文字回答。");
    }
    if (data?.code === "rate_limited" || data?.code === "asr_quota_exceeded") {
      throw new Error(data.error || "语音识别额度已用完，请改用文字回答。");
    }
    throw new Error(data?.error || `语音识别失败（${res.status}）`);
  }
  const text = String(data?.text || "").trim();
  if (!text) throw new Error("没有识别到内容，请说得清楚一点或改用文字。");
  return text;
}
