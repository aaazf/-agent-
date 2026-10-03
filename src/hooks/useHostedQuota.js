import { useEffect, useState } from "react";
import { fetchHealth } from "../lib/runtime.js";

// 站点共享体验额度：既决定"没填 Key 能不能用模型"，也决定界面该显示模型还是本地题库。
// /api/health 在会话内只探一次，所以多个组件同时用不会重复请求。
// 返回值：null = 还在探测，false = 未开启，对象 = 已开启（含 model / perIpPerDay）。
export default function useHostedQuota() {
  const [hosted, setHosted] = useState(null);

  useEffect(() => {
    let alive = true;
    fetchHealth().then((health) => {
      if (!alive) return;
      const info = health?.hostedLlm;
      setHosted(info?.enabled ? info : false);
    });
    return () => {
      alive = false;
    };
  }, []);

  return hosted;
}

// 同步版本，只用于渲染期判断"要不要显示成模型驱动"。
// 真正发起请求前的可用性判断请用 model.js 的 canUseModel(settings)，
// 它还会再确认一次共享额度，不会受探测时序影响。
export function modelAvailable({ settings, hosted } = {}) {
  if (settings?.modelEnabled === false) return false;
  if (settings?.apiKey?.trim()) return true;
  return Boolean(hosted);
}

// 展示用的模型名：自带 Key 用访客选的模型，走共享额度时用部署方托管的模型。
export function displayModelName({ settings, hosted } = {}) {
  if (settings?.apiKey?.trim()) return settings?.modelName || "";
  if (hosted && typeof hosted === "object") return hosted.model || "本站共享额度";
  return "";
}
