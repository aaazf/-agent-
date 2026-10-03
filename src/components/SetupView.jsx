import { useRef, useState } from "react";
import {
  ArrowRight,
  Camera,
  CheckCircle2,
  Cpu,
  Eye,
  FileText,
  LoaderCircle,
  Mic,
  Play,
  Settings2,
  ShieldCheck,
  Sparkles,
  TestTube2,
  UserRound
} from "lucide-react";
import { DEFAULT_SETTINGS, loadSettings } from "../lib/storage.js";
import { PROVIDERS, callModel } from "../lib/model.js";
import useHostedQuota, { displayModelName, modelAvailable } from "../hooks/useHostedQuota.js";

const DIRECTIONS = ["互联网", "电商", "金融", "教育", "企业服务", "医疗", "游戏", "制造业", "其他"];
const ROLES = [
  "前端工程师",
  "后端工程师",
  "全栈工程师",
  "算法工程师",
  "产品经理",
  "数据分析师",
  "测试工程师"
];
const STYLES = ["温和引导", "标准专业", "追问较深", "高压快节奏"];

function Field({ icon, title, desc, children }) {
  return (
    <section className="panel">
      <div className="field-head">
        <span className="field-icon">{icon}</span>
        <div>
          <h2>{title}</h2>
          {desc ? <p>{desc}</p> : null}
        </div>
      </div>
      <div className="field-body">{children}</div>
    </section>
  );
}

function ProviderChip({ label, active, onClick }) {
  return (
    <button type="button" className={`chip ${active ? "chip-active" : ""}`} onClick={onClick}>
      {label}
    </button>
  );
}

function SwitchToggle({ checked, onChange, title, desc }) {
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
        <b>{title}</b>
        <small>{desc}</small>
      </span>
    </button>
  );
}

export default function SetupView({ onStart, onOpenHistory }) {
  const initial = useRef(loadSettings());
  const [form, setForm] = useState({ ...DEFAULT_SETTINGS, ...initial.current });
  const [testState, setTestState] = useState("idle");
  const [testMsg, setTestMsg] = useState("");
  const [notice, setNotice] = useState("");
  // 本站共享额度也代表"能用模型"，表单里的引擎摘要不能再只看 API Key。
  const hosted = useHostedQuota();
  const modelReady = modelAvailable({ settings: form, hosted });
  const modelLabel = displayModelName({ settings: form, hosted });

  const set = (key, value) => setForm((prev) => ({ ...prev, [key]: value }));
  const pickProvider = (provider) => {
    set("modelProvider", provider.label);
    set("baseUrl", provider.baseUrl);
    set("modelName", provider.model);
  };

  async function testApi() {
    setTestState("loading");
    setTestMsg("");
    try {
      await callModel({
        settings: form,
        messages: [{ role: "user", content: "请回复：连接成功" }],
        maxTokens: 20
      });
      setTestState("ok");
      setTestMsg("连接成功，模型可正常返回");
    } catch (err) {
      setTestState("error");
      setTestMsg(err.message || "连接失败");
    }
  }

  function start() {
    const clean = {
      ...form,
      apiKey: form.apiKey.trim(),
      baseUrl: form.baseUrl.trim().replace(/\/+$/, ""),
      modelName: form.modelName.trim(),
      resume: form.resume.trim(),
      jd: form.jd.trim()
    };
    if (!clean.resume || !clean.jd) {
      setNotice("请至少填入一段简短简历和岗位 JD，模型和本地兜底出题都需要上下文。");
      return;
    }
    onStart(clean);
  }

  return (
    <div className="view setup-view">
      <div className="view-intro">
        <div>
          <div className="eyebrow">本地轻量模拟面试</div>
          <h1>面试准备</h1>
          <p>填好岗位上下文后开始一场语音面试。模型会依据你每一轮的回答判断下一道题。</p>
        </div>
        <button className="ghost-btn" onClick={onOpenHistory}>
          <span>最近 7 场记录</span>
          <ArrowRight size={17} />
        </button>
      </div>

      {notice ? <div className="inline-warning">{notice}</div> : null}

      <div className="setup-grid">
        <div className="setup-main">
          <Field icon={<UserRound size={19} />} title="岗位与背景" desc="这些信息会注入模型提示词，也用于无 Key 时的本地出题。">
            <div className="form-grid two">
              <label>
                <span>业务方向</span>
                <select value={form.direction} onChange={(e) => set("direction", e.target.value)}>
                  {DIRECTIONS.map((item) => (
                    <option key={item}>{item}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>目标岗位</span>
                <select value={form.role} onChange={(e) => set("role", e.target.value)}>
                  {ROLES.map((item) => (
                    <option key={item}>{item}</option>
                  ))}
                </select>
              </label>
            </div>

            <div className="form-grid two">
              <label className="textarea-label">
                <span>
                  <FileText size={14} /> 简历 / 项目经历（可粘贴文本）
                </span>
                <textarea
                  value={form.resume}
                  onChange={(e) => set("resume", e.target.value)}
                  rows={6}
                  placeholder="写清年限、技术栈、主要项目与量化结果"
                />
              </label>
              <label className="textarea-label">
                <span>
                  <FileText size={14} /> 岗位 JD / 招聘要求
                </span>
                <textarea
                  value={form.jd}
                  onChange={(e) => set("jd", e.target.value)}
                  rows={6}
                  placeholder="粘贴或简写岗位职责、技术要求、加分项"
                />
              </label>
            </div>
          </Field>

          <Field icon={<Settings2 size={19} />} title="面试节奏" desc="题数决定一场上限；停顿缓冲不会自动收掉候选人正在组织的答案。">
            <div className="form-grid three">
              <label>
                <span>面试官风格</span>
                <select value={form.style} onChange={(e) => set("style", e.target.value)}>
                  {STYLES.map((item) => (
                    <option key={item}>{item}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>题目数量</span>
                <div className="stepper">
                  <button
                    type="button"
                    onClick={() => set("questionCount", Math.max(3, form.questionCount - 1))}
                  >
                    −
                  </button>
                  <span>{form.questionCount}</span>
                  <button
                    type="button"
                    onClick={() => set("questionCount", Math.min(8, form.questionCount + 1))}
                  >
                    +
                  </button>
                </div>
              </label>
              <label>
                <span>停顿缓冲（秒）</span>
                <div className="stepper">
                  <button
                    type="button"
                    onClick={() => set("bufferSeconds", Math.max(3, form.bufferSeconds - 1))}
                  >
                    −
                  </button>
                  <span>{form.bufferSeconds}</span>
                  <button
                    type="button"
                    onClick={() => set("bufferSeconds", Math.min(30, form.bufferSeconds + 1))}
                  >
                    +
                  </button>
                </div>
              </label>
            </div>

            <div className="toggle-row">
              <SwitchToggle
                checked={form.bufferEnabled}
                onChange={(value) => set("bufferEnabled", value)}
                title="启用紧张缓冲"
                desc="安静时先显示缓冲提示，不自动提交，也不因停顿扣临场分"
              />
              <SwitchToggle
                checked={form.cameraOn}
                onChange={(value) => set("cameraOn", value)}
                title="开启摄像头"
                desc="面试开始后可再关闭；画面只在本机显示"
              />
              <SwitchToggle
                checked={form.autoSpeak}
                onChange={(value) => set("autoSpeak", value)}
                title="语音播报"
                desc="用浏览器 TTS 朗读问题；不开启则显示文字"
              />
            </div>
          </Field>

          <Field icon={<Cpu size={19} />} title="模型 API" desc="模型负责根据对话判断提问与终评。未配置或调用失败时自动切本地题库兜底。">
            <div className="provider-row">
              {PROVIDERS.map((provider) => (
                <ProviderChip
                  key={provider.label}
                  label={provider.label}
                  active={form.modelProvider === provider.label}
                  onClick={() => pickProvider(provider)}
                />
              ))}
              <ProviderChip
                label="自定义"
                active={!PROVIDERS.some((item) => item.label === form.modelProvider)}
                onClick={() => set("modelProvider", "自定义")}
              />
            </div>
            <div className="form-grid two">
              <label>
                <span>Base URL</span>
                <input
                  value={form.baseUrl}
                  onChange={(e) => set("baseUrl", e.target.value)}
                  placeholder="https://api.openai.com/v1"
                />
              </label>
              <label>
                <span>模型名</span>
                <input
                  value={form.modelName}
                  onChange={(e) => set("modelName", e.target.value)}
                  placeholder="gpt-4o-mini / deepseek-chat / qwen-plus"
                />
              </label>
            </div>
            <label className="api-key-label">
              <span>API Key</span>
              <input
                type="password"
                value={form.apiKey}
                onChange={(e) => set("apiKey", e.target.value)}
                placeholder="仅保存在当前浏览器 localStorage，并通过本地服务代理转发"
              />
              <button type="button" className="small-btn" onClick={testApi} disabled={testState === "loading"}>
                {testState === "loading" ? <LoaderCircle className="spin" size={15} /> : <TestTube2 size={15} />}
                测试连接
              </button>
            </label>
            {testMsg ? (
              <div className={`test-result ${testState}`}>
                {testState === "ok" ? <CheckCircle2 size={15} /> : <span className="dot" />}
                {testMsg}
              </div>
            ) : null}
            <div className="hint-block">
              <Sparkles size={15} />
              未配置模型 API 时仍可开始面试，出题会退回本地题库；建议先填 Key 以获得模型驱动的完整体验。
            </div>
          </Field>
        </div>

        <aside className="setup-side">
          <section className="panel summary-card">
            <div className="summary-title">
              <Eye size={18} />
              本场概览
            </div>
            <div className="summary-rows">
              <div>
                <span>岗位</span>
                <b>{form.role}</b>
              </div>
              <div>
                <span>方向</span>
                <b>{form.direction}</b>
              </div>
              <div>
                <span>题数上限</span>
                <b>{form.questionCount} 题</b>
              </div>
              <div>
                <span>提问引擎</span>
                <b>
                  {modelReady
                    ? form.apiKey
                      ? `${form.modelProvider} / ${form.modelName}`
                      : `本站共享额度 / ${modelLabel}`
                    : "本地题库（未配置 Key）"}
                </b>
              </div>
              <div>
                <span>缓冲</span>
                <b>{form.bufferEnabled ? `${form.bufferSeconds} 秒提示` : "不启用"}</b>
              </div>
            </div>
          </section>

          <section className="panel privacy-card">
            <ShieldCheck size={19} />
            <div>
              <b>本地优先</b>
              <p>简历、历史结果与 API Key 默认只存在你的浏览器。只有主动调用模型时，会把当前题目上下文发送给你配置的模型服务。</p>
            </div>
          </section>

          <section className="panel ready-card">
            <div className="ready-cards">
              <div>
                <Mic size={17} />
                语音回答
              </div>
              <div>
                <Camera size={17} />
                可开摄像头
              </div>
            </div>
            <button className="primary-btn wide" onClick={start}>
              <Play size={18} fill="currentColor" />
              开始本场面试
            </button>
            <p className="micro-copy">进入面试页后需要点击一次“开始回答”以授予麦克风权限；识别失败时可随时改用文字。</p>
          </section>
        </aside>
      </div>
    </div>
  );
}
