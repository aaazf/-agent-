// 运行环境探测：是否被创空间等第三方页面内嵌，以及服务端能力（TTS、共享额度）。

export function isEmbedded() {
  try {
    return window.self !== window.top;
  } catch {
    // 跨源访问 window.top 会抛错，恰好说明确实处于被内嵌状态
    return true;
  }
}

export function openInNewWindow() {
  window.open(window.location.href, "_blank", "noopener,noreferrer");
}

let healthPromise = null;

// /api/health 结果在会话内缓存：能力状态不会在页面生命周期内变化，避免重复探测。
export function fetchHealth() {
  if (!healthPromise) {
    healthPromise = fetch("/api/health", { method: "POST" })
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null);
  }
  return healthPromise;
}

// 站点是否提供共享体验额度（访客不填 Key 也能用模型）。
export async function hasHostedQuota() {
  const health = await fetchHealth();
  return Boolean(health?.hostedLlm?.enabled);
}

// 服务端语音识别能力（部署方配置 ASR_* 后可用，访客不需要自带 Key）。
export async function asrCapability() {
  const health = await fetchHealth();
  const asr = health?.asr;
  if (!asr) return { available: false, model: "", reason: "未探测到服务端语音识别能力" };
  return { available: Boolean(asr.available), model: asr.model || "", reason: asr.reason || "" };
}
