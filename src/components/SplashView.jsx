import { useEffect, useState } from "react";
import { ArrowRight, Sparkles } from "lucide-react";
import GalaxyCanvas from "./GalaxyCanvas.jsx";

export default function SplashView({ onEnter }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const show = window.setTimeout(() => setVisible(true), 80);
    // onEnter 缺省时（启动阶段还在确认登录态）只展示，不自动跳转，
    // 否则会把已登录的访客"自动送"到登录页。
    const timer = onEnter ? window.setTimeout(() => onEnter(), 3200) : null;
    return () => {
      window.clearTimeout(show);
      if (timer) window.clearTimeout(timer);
    };
  }, [onEnter]);

  return (
    <div className={`splash-page ${visible ? "visible" : ""}`}>
      <div className="splash-rays" />
      <GalaxyCanvas className="splash-galaxy" />
      <div className="splash-center">
        <div className="splash-logo-wrap">
          <img src="/logo.png" alt="AI 面试 Agent Logo" className="splash-logo" />
          <span className="splash-ring ring-one" />
          <span className="splash-ring ring-two" />
        </div>
        <h1>AI 面试 Agent</h1>
        <p>理解回答 · 判断能力 · 动态追问 · 完整复盘</p>
        <button className="splash-enter" onClick={onEnter}>
          <Sparkles size={15} />
          进入面试中心
          <ArrowRight size={15} />
        </button>
      </div>
      <div className="splash-footer">Model-driven mock interview</div>
    </div>
  );
}
