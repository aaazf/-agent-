import { useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  Bot,
  Camera,
  CheckCircle2,
  FileCheck2,
  KeyRound,
  LockKeyhole,
  Mic,
  ShieldCheck,
  Sparkles,
  UserRound
} from "lucide-react";
import GalaxyCanvas from "./GalaxyCanvas.jsx";
import { loginAccount, registerAccount, saveToken } from "../lib/auth.js";
import { dataFlowFull } from "../lib/privacy.js";
import { getSpeechRecognitionCtor } from "../hooks/useSpeechRecognition.js";
import { fetchHealth } from "../lib/runtime.js";

export default function LoginView({ onAuthed, notice = "" }) {
  const [mode, setMode] = useState("login");
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [accounts, setAccounts] = useState(null);
  const [asr, setAsr] = useState(null);

  useEffect(() => {
    let alive = true;
    // 注册开关/邀请码/持久化能力都由服务端告诉我们，避免前后端两套默认值。
    fetchHealth().then((health) => {
      if (!alive) return;
      setAccounts(health?.accounts || null);
      setAsr(health?.asr || null);
    });
    return () => {
      alive = false;
    };
  }, []);

  const signupOpen = accounts ? accounts.signup !== false : true;
  const inviteRequired = Boolean(accounts?.inviteRequired);

  // 录音去往哪里，取决于本站实际用哪种识别：探测结果拿到之前传 undefined，
  // 让文案退回中性说法，避免先闪一句与本站不符的承诺。
  const browserAsr = Boolean(getSpeechRecognitionCtor());
  const voiceEngine = asr ? (asr.available ? "server" : browserAsr ? "browser" : "text") : undefined;

  async function submit(e) {
    e.preventDefault();
    if (loading) return;
    setError("");
    const name = account.trim();
    if (!name) {
      setError("请输入账号（邮箱或用户名）");
      return;
    }
    if (!password) {
      setError("请输入密码");
      return;
    }
    if (mode === "register") {
      if (!signupOpen) {
        setError("本站当前未开放注册。");
        return;
      }
      if (password.length < 8) {
        setError("密码至少 8 位，且同时包含字母和数字。");
        return;
      }
      if (password !== confirm) {
        setError("两次输入的密码不一致。");
        return;
      }
    }
    setLoading(true);
    try {
      const data =
        mode === "register"
          ? await registerAccount({ account: name, password, inviteCode: inviteCode.trim() })
          : await loginAccount({ account: name, password });
      saveToken(data.token);
      onAuthed(data.user);
    } catch (err) {
      setError(err?.message || "操作失败，请稍后重试。");
    } finally {
      setLoading(false);
    }
  }

  function switchMode(next) {
    setMode(next);
    setError("");
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
          账号登录 · 简历随账号保存
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
              <h2>{mode === "register" ? "创建账号，开始练习" : "登录面试工作台"}</h2>
              <p>
                {mode === "register"
                  ? "用户名或邮箱都可以，不需要邮箱验证码；账号只用来给你单独保存简历与练习记录。"
                  : "每个账号的简历、面试记录与设置互相隔离，换设备登录也能找回自己的简历。"}
              </p>
            </div>
          </div>

          {signupOpen ? (
            <div className="login-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                data-mode="login"
                aria-selected={mode === "login"}
                className={`login-tab ${mode === "login" ? "active" : ""}`}
                onClick={() => switchMode("login")}
              >
                登录
              </button>
              <button
                type="button"
                role="tab"
                data-mode="register"
                aria-selected={mode === "register"}
                className={`login-tab ${mode === "register" ? "active" : ""}`}
                onClick={() => switchMode("register")}
              >
                注册新账号
              </button>
            </div>
          ) : null}

          <form onSubmit={submit}>
            <label>
              <span>
                <UserRound size={14} />
                账号（邮箱或用户名）
              </span>
              <input
                className="login-account"
                value={account}
                autoComplete="username"
                onChange={(e) => setAccount(e.target.value)}
                placeholder="例如 zhangsan 或 zhangsan@example.com"
              />
            </label>
            <label>
              <span>
                <KeyRound size={14} />
                密码
              </span>
              <input
                className="login-password"
                type="password"
                value={password}
                autoComplete={mode === "register" ? "new-password" : "current-password"}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={mode === "register" ? "至少 8 位，含字母和数字" : "输入账号密码"}
              />
            </label>
            {mode === "register" ? (
              <>
                <label>
                  <span>
                    <ShieldCheck size={14} />
                    确认密码
                  </span>
                  <input
                    className="login-confirm"
                    type="password"
                    value={confirm}
                    autoComplete="new-password"
                    onChange={(e) => setConfirm(e.target.value)}
                    placeholder="再输入一次密码"
                  />
                </label>
                {inviteRequired ? (
                  <label>
                    <span>
                      <KeyRound size={14} />
                      邀请码
                    </span>
                    <input
                      className="login-invite"
                      value={inviteCode}
                      onChange={(e) => setInviteCode(e.target.value)}
                      placeholder="部署方提供的邀请码"
                    />
                  </label>
                ) : null}
              </>
            ) : null}

            {error ? (
              <p className="login-error" role="alert">
                <AlertTriangle size={14} />
                {error}
              </p>
            ) : null}
            {notice && !error ? <p className="login-notice">{notice}</p> : null}

            <button className="primary-btn login-submit" disabled={loading}>
              {loading ? <span className="mini-loader" /> : <ArrowRight size={18} />}
              {loading ? "正在处理…" : mode === "register" ? "注册并进入面试中心" : "登录并进入面试中心"}
            </button>
          </form>

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
              <b>简历随账号走</b>
              <small>换设备登录也能找回自己的简历</small>
            </div>
            <div>
              <CheckCircle2 size={18} />
              <b>账号互相隔离</b>
              <small>同一台电脑换人登录互不可见</small>
            </div>
          </div>

          <p className="login-note">
            <Sparkles size={13} />
            {dataFlowFull(voiceEngine)}
          </p>
          {accounts && accounts.persistent === false ? (
            <p className="login-note login-note-warn">
              <AlertTriangle size={13} />
              当前部署未挂载持久化存储，容器重启后账号与简历可能丢失，请勿存放重要个人信息。
            </p>
          ) : null}
        </section>
      </main>
    </div>
  );
}
