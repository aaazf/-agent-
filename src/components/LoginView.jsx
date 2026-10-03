import { useState } from "react";
import {
  ArrowRight,
  BarChart3,
  Bot,
  Camera,
  CheckCircle2,
  FileCheck2,
  KeyRound,
  LockKeyhole,
  Mic,
  Sparkles,
  UserRound,
} from "lucide-react";
import GalaxyCanvas from "./GalaxyCanvas.jsx";

export default function LoginView({ onLogin }) {
  const [email, setEmail] = useState("demo@interview.local");
  const [password, setPassword] = useState("demo");
  const [loading, setLoading] = useState(false);

  function submit(e) {
    e.preventDefault();
    setLoading(true);
    window.setTimeout(() => {
      onLogin({ email, password });
    }, 420);
  }

  return (
    <div className="login-view">
      <div className="login-backdrop" />
      <header className="login-top">
        <div className="brand brand-light">
          <img className="login-logo-mini" src="/logo.png" alt="AI 面试 Agent" />
          <div>
            <b>面对面 AI 模拟面试</b>
            <small>模型驱动提问 · 5 段式面试流程</small>
          </div>
        </div>
        <span className="login-badge">
          <LockKeyhole size={13} />
          本地演示环境
        </span>
      </header>

      <main className="login-main">
        <section className="login-intro">
          <GalaxyCanvas className="login-galaxy" />
          <img className="login-logo-intro" src="/logo.png" alt="AI 面试 Agent" />
          <div className="eyebrow light">01 · 登录入口</div>
          <h1>从准备到复盘，<br />一场面试拆成完整闭环</h1>
          <p>按真实面试节奏推进：先接入模型，再准备岗位材料，随后进入语音面试，结束后生成报告与连续练习记录。</p>
          <div className="login-flow-steps">
            {[
              { num: "01", label: "登录入口" },
              { num: "02", label: "面试中心" },
              { num: "03", label: "简历分析" },
              { num: "04", label: "模拟面试" },
              { num: "05", label: "记录复盘" }
            ].map((item) => (
              <div key={item.num}>
                <b>{item.num}</b>
                <span>{item.label}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="login-card">
          <div className="login-card-head">
            <span className="login-card-icon">
              <UserRound size={20} />
            </span>
            <div>
              <h2>进入面试工作台</h2>
              <p>演示阶段跳过真实鉴权，点击继续进入面试中心；模型接入在系统设置中单独提供。</p>
            </div>
          </div>

          <form onSubmit={submit}>
            <label>
              <span>
                <UserRound size={14} />
                邮箱 / 用户名
              </span>
              <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="demo@interview.local" />
            </label>
            <label>
              <span>
                <KeyRound size={14} />
                密码
              </span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="演示环境任意输入"
              />
            </label>
            <button className="primary-btn login-submit" disabled={loading}>
              {loading ? <span className="mini-loader" /> : <ArrowRight size={18} />}
              {loading ? "正在进入…" : "登录并进入面试中心"}
            </button>
          </form>

          <div className="login-demo-row">
            <span>演示账号</span>
            <code>demo@interview.local / demo</code>
            <button type="button" onClick={() => {
              setEmail("demo@interview.local");
              setPassword("demo");
            }}>
              <CheckCircle2 size={14} />
              一键填入
            </button>
          </div>

          <div className="login-features">
            <div>
              <Bot size={18} />
              <b>模型动态提问</b>
              <small>理解回答后决定追问或换题</small>
            </div>
            <div>
              <Mic size={18} />
              <b>自动语音听答</b>
              <small>说完自动识别并继续下一题</small>
            </div>
            <div>
              <Camera size={18} />
              <b>设备预检</b>
              <small>麦克风与摄像头可提前检测</small>
            </div>
            <div>
              <BarChart3 size={18} />
              <b>最近 7 场</b>
              <small>总分与维度趋势对比</small>
            </div>
            <div>
              <FileCheck2 size={18} />
              <b>逐题复盘</b>
              <small>每题给出可执行改进方案</small>
            </div>
            <div>
              <CheckCircle2 size={18} />
              <b>本地数据</b>
              <small>记录默认只保存在本机</small>
            </div>
          </div>

          <p className="login-note">
            <Sparkles size={13} />
            数据默认只保存在当前浏览器 localStorage，不会上传到公共服务器。
          </p>
        </section>
      </main>
    </div>
  );
}
