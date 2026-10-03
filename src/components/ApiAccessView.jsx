import { useEffect, useState } from "react";
import {
  ArrowRight,
  AudioLines,
  CheckCircle2,
  Cpu,
  KeyRound,
  LoaderCircle,
  Mic,
  Server,
  ShieldCheck,
  Sparkles,
  TestTube2,
  Video
} from "lucide-react";
import { callModel } from "../lib/model.js";
import { PROVIDER_OPTIONS as PROVIDERS } from "../lib/providers.js";
import { fetchHealth } from "../lib/runtime.js";

function Switch({ checked, onChange, title, desc, icon }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className="switch-line"
      onClick={() => onChange(!checked)}
    >
      <span className="switch" />
      <span>
        <b>
          {icon}
          {title}
        </b>
        <small>{desc}</small>
      </span>
    </button>
  );
}

export default function ApiAccessView({
  settings,
  onNext,
  standalone = false,
  onSaved,
  allowEmpty = false,
  onBack
}) {
  const [form, setForm] = useState({ ...settings });
  const [testState, setTestState] = useState("idle");
  const [testMsg, setTestMsg] = useState("");
  const [testResponse, setTestResponse] = useState("");
  const provider = PROVIDERS.find((item) => item.label === form.modelProvider) || PROVIDERS[0];
  const isCatalogModel = provider.models.includes(form.modelName);
  const [hostedQuota, setHostedQuota] = useState(null);

  useEffect(() => {
    let alive = true;
    fetchHealth().then((health) => {
      if (alive) setHostedQuota(health?.hostedLlm?.enabled ? health.hostedLlm : false);
    });
    return () => {
      alive = false;
    };
  }, []);

  const set = (key, value) => setForm((prev) => ({ ...prev, [key]: value }));

  function pickProvider(item) {
    setForm((prev) => ({
      ...prev,
      modelProvider: item.label,
      baseUrl: item.baseUrl,
      modelName: item.models[0] || prev.modelName
    }));
  }

  async function test() {
    setTestState("loading");
    setTestMsg("");
    setTestResponse("");
    try {
      const reply = await callModel({
        settings: form,
        messages: [{ role: "user", content: "请只回复：连接成功" }],
        maxTokens: 10
      });
      setTestResponse((reply || "").slice(0, 140));
      setTestState("ok");
      setTestMsg("连接成功，模型可以正常接收请求");
    } catch (err) {
      setTestState("error");
      setTestMsg(err.message || "连接失败，请检查 Base URL / Key / 模型");
      setTestResponse("");
    }
  }

  function next() {
    if (!standalone && !allowEmpty && !form.apiKey.trim() && !hostedQuota) {
      setTestMsg("API Key 不能为空；没有 Key 时可以跳过此页，后续会使用本地题库兜底。");
      setTestState("error");
      return;
    }
    const saved = {
      ...form,
      baseUrl: form.baseUrl.trim().replace(/\/+$/, ""),
      modelName: form.modelName.trim(),
      apiKey: form.apiKey.trim()
    };
    (standalone && onSaved ? onSaved : onNext)(saved);
  }

  return (
    <div className="module-page api-page">
      <div className="module-heading">
        <div>
          <div className="eyebrow">{standalone ? "系统设置 · 模型接入" : "前置引导 · 1/4 · API 接入"}</div>
          <h1>{standalone ? "模型接入" : "选择并接入大模型"}</h1>
          <p>选择服务商和具体模型，面试中的动态提问与终评将由该模型完成。</p>
        </div>
        <div className="module-heading-note">
          {onBack ? (
            <button className="ghost-btn heading-back-btn" type="button" onClick={onBack}>
              ← 返回上一步
            </button>
          ) : null}
          <span className="heading-security-note">
            <ShieldCheck size={15} />
            Key 仅存本机
          </span>
        </div>
      </div>

      {hostedQuota ? (
        <div className="hint-block">
          <Sparkles size={15} />
          本站已开启共享体验额度（模型 {hostedQuota.model}，每人每日 {hostedQuota.perIpPerDay} 次），API Key 可以留空直接开始。
        </div>
      ) : null}

      <div className="api-layout">
        <section className="panel api-main">
          <div className="api-section-title">
            <Cpu size={18} />
            <div>
              <b>模型服务商</b>
              <small>点击卡片切换服务商与默认模型</small>
            </div>
          </div>

          <div className="provider-cards">
            {PROVIDERS.map((item) => {
              const active = form.modelProvider === item.label;
              return (
                <button
                  type="button"
                  key={item.label}
                  className={`provider-card ${active ? "active" : ""}`}
                  onClick={() => pickProvider(item)}
                >
                  <span className="provider-mark">{item.label.slice(0, 1)}</span>
                  <span>
                    <b>{item.label}</b>
                    <small>{item.models.length ? item.models.slice(0, 2).join(" / ") : "自定义接入"}</small>
                  </span>
                  {active ? <CheckCircle2 size={16} /> : null}
                </button>
              );
            })}
          </div>

          <div className="api-form-block">
            <div className="api-section-title">
              <Server size={18} />
              <div>
                <b>接口与模型</b>
                <small>OpenAI 兼容接口，可连接 DeepSeek / 千问 / GLM / Kimi</small>
              </div>
            </div>

            <div className="form-grid two">
              <label>
                <span>Base URL</span>
                <input value={form.baseUrl} onChange={(e) => set("baseUrl", e.target.value)} />
              </label>
              <label>
                <span>模型</span>
                <div className="model-select-row">
                  <select
                    value={isCatalogModel ? form.modelName : "__custom__"}
                    onChange={(e) => {
                      const value = e.target.value;
                      if (value === "__custom__") {
                        set("modelName", "");
                      } else {
                        set("modelName", value);
                      }
                    }}
                  >
                    {provider.models.length ? (
                      provider.models.map((model) => (
                        <option key={model} value={model}>
                          {model}
                        </option>
                      ))
                    ) : (
                      <option value="">自定义模型</option>
                    )}
                    <option value="__custom__">自定义模型名称…</option>
                  </select>
                  {!isCatalogModel ? (
                    <input
                      value={form.modelName}
                      onChange={(e) => set("modelName", e.target.value)}
                      placeholder="输入模型名"
                    />
                  ) : null}
                </div>
              </label>
            </div>

            <label className="api-key-label">
              <span>API Key</span>
              <input
                type="password"
                value={form.apiKey}
                onChange={(e) => set("apiKey", e.target.value)}
                placeholder="sk-…"
              />
              <button type="button" className="small-btn" onClick={test} disabled={testState === "loading"}>
                {testState === "loading" ? <LoaderCircle className="spin" size={15} /> : <TestTube2 size={15} />}
                测试连接
              </button>
            </label>

            {testMsg ? (
              <div className={`test-result ${testState}`}>
                {testState === "ok" ? <CheckCircle2 size={15} /> : <span className="dot" />}
                {testMsg}
                {testResponse ? <span className="test-reply">模型返回：{testResponse}</span> : null}
              </div>
            ) : null}

            <div className="hint-block">
              <Sparkles size={15} />
              {standalone
                ? "没有 Key 时可直接保存为本地题库模式，后续填入 Key 并测试成功后即可切换模型驱动。"
                : "如果暂时没有 Key，也可以直接点“下一步”，面试将使用本地题库与规则评分；后续在此页填入 Key 即可切换模型驱动。"}
            </div>
          </div>

          <div className="api-form-block">
            <div className="api-section-title">
              <Mic size={18} />
              <div>
                <b>语音与设备</b>
                <small>浏览器内语音识别、TTS 播报与可选摄像头</small>
              </div>
            </div>
            <div className="toggle-row">
              <Switch
                checked={form.autoSpeak}
                onChange={(value) => set("autoSpeak", value)}
                title="语音播报"
                desc="用浏览器 TTS 朗读面试官问题"
                icon={<AudioLines size={14} />}
              />
              <Switch
                checked={form.cameraOn}
                onChange={(value) => set("cameraOn", value)}
                title="开启摄像头"
                desc="进入面试后展示候选人画面"
                icon={<Video size={14} />}
              />
              <Switch
                checked={form.bufferEnabled}
                onChange={(value) => set("bufferEnabled", value)}
                title="紧张缓冲"
                desc="停顿后不自动收题，安静提示缓冲"
                icon={<ShieldCheck size={14} />}
              />
            </div>
            <label className="buffer-field">
              <span>缓冲阈值</span>
              <div className="stepper">
                <button type="button" onClick={() => set("bufferSeconds", Math.max(3, form.bufferSeconds - 1))}>
                  −
                </button>
                <span>{form.bufferSeconds} 秒</span>
                <button type="button" onClick={() => set("bufferSeconds", Math.min(30, form.bufferSeconds + 1))}>
                  +
                </button>
              </div>
            </label>
            <label className="voice-picker-field">
              <span>面试官声音</span>
              <select value={form.voiceName || "auto"} onChange={(e) => set("voiceName", e.target.value)}>
                <option value="auto">自动选择自然中文音色</option>
                <option value="XiaoxiaoNeural">晓晓 · 温柔女声（Neural）</option>
                <option value="YunxiNeural">云希 · 温和男声（Neural）</option>
                <option value="XiaoyiNeural">晓伊 · 年轻女声（Neural）</option>
                <option value="YunjianNeural">云健 · 沉稳男声（Neural）</option>
                <option value="system">跟随系统默认语音</option>
              </select>
            </label>
          </div>
        </section>

        <aside className="panel api-side">
          <div className="summary-title">
            <KeyRound size={17} />
            当前模型
          </div>
          <div className="selected-model">
            <span className="provider-mark">{form.modelProvider.slice(0, 1)}</span>
            <div>
              <b>{form.modelProvider}</b>
              <small>{form.modelName || "未选择模型"}</small>
            </div>
          </div>
          <div className="summary-rows">
            <div>
              <span>连接状态</span>
              <b>{testState === "ok" ? "正常" : testState === "error" ? "失败" : "未测试"}</b>
            </div>
            <div>
              <span>提问引擎</span>
              <b>{form.apiKey ? form.modelName : "本地题库"}</b>
            </div>
            <div>
              <span>语音</span>
              <b>{form.autoSpeak ? "开启" : "文字"}</b>
            </div>
            <div>
              <span>摄像头</span>
              <b>{form.cameraOn ? "开启" : "关闭"}</b>
            </div>
          </div>
          <button
            type="button"
            className="outline-btn wide test-model-btn"
            onClick={test}
            disabled={testState === "loading"}
          >
            {testState === "loading" ? <LoaderCircle className="spin" size={16} /> : <TestTube2 size={16} />}
            {testState === "loading" ? "正在测试模型接入…" : "测试模型是否接入成功"}
          </button>
          <button className="primary-btn wide next-btn" onClick={next}>
            {standalone ? "保存模型配置" : "下一步：面试准备"}
            <ArrowRight size={17} />
          </button>
          {!form.apiKey && !standalone ? (
            <button className="ghost-btn wide" onClick={() => onNext({ ...form })}>
              暂不接入，本地题库继续
            </button>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
