import { useEffect, useState } from "react";
import { ArrowRight, Camera, Check, LoaderCircle, MessageSquareText, Mic, Video } from "lucide-react";
import { getSpeechRecognitionCtor } from "../hooks/useSpeechRecognition.js";
import { fetchHealth, isEmbedded } from "../lib/runtime.js";

function ModeCard({ mode, current, onChange }) {
  return (
    <button
      type="button"
      className={current === mode ? "mode-card active" : "mode-card"}
      onClick={() => onChange(mode)}
    >
      {mode === "text" ? <MessageSquareText size={22} /> : <Video size={22} />}
      <span>
        <b>{mode === "text" ? "文字面试" : "面对面语音 / 视频面试"}</b>
        <small>
          {mode === "text"
            ? "输入回答，回车发送，适合安静环境"
            : "自动听答，可开启摄像头，说完自动进入下一题"}
        </small>
      </span>
    </button>
  );
}

export default function DeviceSetupPage({ settings, onBack, onNext }) {
  const [form, setForm] = useState({ ...settings });
  const speechSupported = Boolean(getSpeechRecognitionCtor());
  const [serverAsr, setServerAsr] = useState("");

  useEffect(() => {
    let alive = true;
    fetchHealth().then((health) => {
      if (alive && health?.asr?.available) setServerAsr(health.asr.model || "服务端识别");
    });
    return () => {
      alive = false;
    };
  }, []);
  const [micState, setMicState] = useState("idle");
  const [cameraState, setCameraState] = useState("idle");
  const [micMsg, setMicMsg] = useState("");
  const [cameraMsg, setCameraMsg] = useState("");

  async function checkMic() {
    setMicState("loading");
    setMicMsg("");
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("浏览器不支持麦克风");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      window.setTimeout(() => stream.getTracks().forEach((track) => track.stop()), 1000);
      setMicState("ok");
      setMicMsg("麦克风正常，可以语音作答");
    } catch {
      setMicState("error");
      setMicMsg("麦克风不可用或权限被拒绝");
    }
  }

  async function checkCamera() {
    setCameraState("loading");
    setCameraMsg("");
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("浏览器不支持摄像头");
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      window.setTimeout(() => stream.getTracks().forEach((track) => track.stop()), 1000);
      setCameraState("ok");
      setCameraMsg("摄像头正常");
    } catch {
      setCameraState("error");
      setCameraMsg("摄像头不可用或权限被拒绝");
    }
  }

  return (
    <div className="module-page onboarding-page">
      <div className="module-heading">
        <div>
          <div className="eyebrow">前置引导 · 3/4</div>
          <h1>设备检测与面试类型</h1>
          <p>先确认麦克风、摄像头是否可用，再选择这一场适合你的面试形式。</p>
        </div>
        <button className="ghost-btn" onClick={onBack}>
          ← 上一步
        </button>
      </div>

      <div className="onboarding-grid">
        <section className="panel device-panel">
          <div className="api-section-title">
            <Mic size={18} />
            <div>
              <b>麦克风检测</b>
              <small>语音识别需要麦克风权限</small>
            </div>
          </div>
          {speechSupported ? null : (
            <div className="inline-warning">
              当前浏览器不支持语音识别（Web Speech API），语音面试会自动降级为文字回答。
              建议使用最新版 Chrome 或 Edge。
            </div>
          )}
          {isEmbedded() ? (
            <div className="inline-warning">
              当前页面被内嵌打开，浏览器可能直接拒绝麦克风/摄像头权限；可靠做法是点页面底部的“在新窗口打开”，或直接使用文字面试。
            </div>
          ) : null}
          {serverAsr ? (
            <div className="hint-block">
              <Mic size={14} />
              服务端语音识别已启用（{serverAsr}）：语音作答不依赖浏览器自带语音服务，内嵌场景更稳。
            </div>
          ) : null}
          <div className="device-check-line">
            <button className="outline-btn" onClick={checkMic} disabled={micState === "loading"}>
              {micState === "loading" ? <LoaderCircle className="spin" size={15} /> : micState === "ok" ? <Check size={15} /> : <Mic size={15} />}
              {micState === "loading" ? "检测中…" : micState === "ok" ? "麦克风已就绪" : "检测麦克风"}
            </button>
            {micMsg ? <span className={micState}>{micMsg}</span> : null}
          </div>

          <div className="api-section-title camera-title">
            <Camera size={18} />
            <div>
              <b>摄像头检测</b>
              <small>视频面试可显示候选人画面</small>
            </div>
          </div>
          <div className="device-check-line">
            <button className="outline-btn" onClick={checkCamera} disabled={cameraState === "loading"}>
              {cameraState === "loading" ? <LoaderCircle className="spin" size={15} /> : cameraState === "ok" ? <Check size={15} /> : <Camera size={15} />}
              {cameraState === "loading" ? "检测中…" : cameraState === "ok" ? "摄像头已就绪" : "检测摄像头"}
            </button>
            {cameraMsg ? <span className={cameraState}>{cameraMsg}</span> : null}
          </div>
        </section>

        <section className="panel type-panel">
          <div className="api-section-title">
            <MessageSquareText size={18} />
            <div>
              <b>选择面试类型</b>
              <small>后续仍可在模拟面试准备页修改</small>
            </div>
          </div>
          <div className="mode-picker">
            <ModeCard mode="text" current={form.interviewMode} onChange={(value) => setForm((prev) => ({ ...prev, interviewMode: value }))} />
            <ModeCard mode="voice" current={form.interviewMode} onChange={(value) => setForm((prev) => ({ ...prev, interviewMode: value }))} />
          </div>
          <button className="primary-btn wide next-btn" onClick={() => onNext(form)}>
            下一步：进入模拟面试
            <ArrowRight size={17} />
          </button>
        </section>
      </div>
    </div>
  );
}
