import { useState } from "react";
import { ExternalLink, Info, X } from "lucide-react";
import { isEmbedded, openInNewWindow } from "../lib/runtime.js";

// 被创空间等第三方页面内嵌时，父级 iframe 未必带 allow="microphone; camera"，
// 浏览器会直接拒绝权限请求；提前说明并给出「新窗口打开」这条可靠路径。
export default function EmbedNotice() {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed || !isEmbedded()) return null;

  return (
    <div className="embed-notice" role="status">
      <Info size={16} />
      <div>
        <b>当前页面运行在内嵌窗口中</b>
        <small>
          浏览器可能拒绝麦克风/摄像头权限，语音面试会自动降级为文字作答；需要完整体验请在新窗口打开。
        </small>
      </div>
      <button type="button" className="small-btn" onClick={openInNewWindow}>
        <ExternalLink size={14} />
        在新窗口打开
      </button>
      <button type="button" className="embed-notice-close" onClick={() => setDismissed(true)} aria-label="关闭提示">
        <X size={15} />
      </button>
    </div>
  );
}