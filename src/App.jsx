import { useEffect, useState } from "react";
import {
  BarChart3,
  ChevronRight,
  Cpu,
  FileStack,
  LayoutDashboard,
  LogOut,
  Mic2,
  Palette,
  ShieldCheck,
  Sparkles,
  UserRound
} from "lucide-react";
import LoginView from "./components/LoginView.jsx";
import WorkbenchPage from "./components/WorkbenchPage.jsx";
import ResumeAnalysisPage from "./components/ResumeAnalysisPage.jsx";
import ResumeSetupView from "./components/ResumeSetupView.jsx";
import InterviewView from "./components/InterviewView.jsx";
import ReportView from "./components/ReportView.jsx";
import HistoryView from "./components/HistoryView.jsx";
import ApiAccessView from "./components/ApiAccessView.jsx";
import SplashView from "./components/SplashView.jsx";
import DeviceSetupPage from "./components/DeviceSetupPage.jsx";
import ThemePalette from "./components/ThemePalette.jsx";
import EmbedNotice from "./components/EmbedNotice.jsx";
import AccountDataPanel from "./components/AccountDataPanel.jsx";
import { logoutAccount, onUnauthorized, restoreSession } from "./lib/auth.js";
import {
  DEFAULT_SETTINGS,
  adoptLegacyLocalData,
  clearLocalData,
  clearStorageScope,
  deleteResult,
  hasOnboarded,
  loadHistory,
  loadSettings,
  loadTheme,
  markOnboarded,
  saveSettings,
  saveTheme,
  setStorageScope
} from "./lib/storage.js";
import { dataFlowCompact } from "./lib/privacy.js";

const NAV_GROUPS = [
  {
    title: "面试准备",
    items: [
      { key: "workbench", label: "面试中心", icon: LayoutDashboard, desc: "快速开始与全局状态" },
      { key: "resume", label: "简历分析", icon: FileStack, desc: "导入简历，生成候选人画像" },
      { key: "simulate", label: "模拟面试", icon: Mic2, desc: "文字 / 语音视频面试" },
      { key: "records", label: "面试记录", icon: BarChart3, desc: "报告与 7 场成长对比" }
    ]
  },
  {
    title: "系统设置",
    items: [
      { key: "model", label: "模型接入", icon: Cpu, desc: "选择模型并测试 API" }
    ]
  }
];

export default function App() {
  const [bootStage, setBootStage] = useState("splash");
  // authState: checking = 正在用本机 token 向服务端确认登录态
  const [authState, setAuthState] = useState("checking");
  const [user, setUser] = useState(null);
  const [authNotice, setAuthNotice] = useState("");
  const [theme, setTheme] = useState(() => loadTheme() || "black");
  const [page, setPage] = useState("workbench");
  const [settings, setSettings] = useState(() => loadSettings());
  const [history, setHistory] = useState(() => loadHistory());
  const [currentResult, setCurrentResult] = useState(null);
  const [summaryTab, setSummaryTab] = useState("records");
  const [onboardingStep, setOnboardingStep] = useState(1);

  useEffect(() => {
    saveTheme(theme);
  }, [theme]);

  // 启动时恢复登录态。三种结果要分开处理：确认登录 → 直接进工作台；
  // 没有有效会话 → 落到登录页；服务端连不上 → 也去登录页，但要说明原因，
  // 不能让访客以为"我的账号被清空了"。
  useEffect(() => {
    let alive = true;
    restoreSession().then((result) => {
      if (!alive) return;
      if (result.status === "authenticated") {
        enterAccount(result.user);
        return;
      }
      if (result.status === "offline") {
        setAuthNotice(`暂时无法连接服务端（${result.error}），登录与简历保存需要服务端可用。`);
      }
      setAuthState("anonymous");
    });
    return () => {
      alive = false;
    };
  }, []);

  // 会话在使用过程中过期（默认 30 天，也可能被部署方调短）：任何接口回 401
  // 都会走到这里，把访客送回登录页并说明原因，而不是让他对着一屏报错发呆。
  useEffect(
    () =>
      onUnauthorized(() => {
        clearStorageScope();
        setUser(null);
        setAuthState("anonymous");
        setBootStage("login");
        setSettings({ ...DEFAULT_SETTINGS });
        setHistory([]);
        setCurrentResult(null);
        setSummaryTab("records");
        setAuthNotice("登录状态已过期，请重新登录；账号里的简历不会丢。");
      }),
    []
  );

  // 切换账号作用域：本机的设置/记录/中场快照都跟着账号走，
  // 顺手把登录前留下的无后缀老数据认领到当前账号。
  function enterAccount(nextUser) {
    setStorageScope(nextUser?.id);
    adoptLegacyLocalData();
    setUser(nextUser);
    setAuthState("authed");
    setBootStage("app");
    setSettings(loadSettings());
    setHistory(loadHistory());
    setCurrentResult(null);
    setSummaryTab("records");
    setPage(hasOnboarded() ? "workbench" : "onboarding");
    setOnboardingStep(1);
    setAuthNotice("");
  }

  function handleAuthed(nextUser) {
    enterAccount(nextUser);
  }

  async function handleLogout() {
    await logoutAccount();
    clearStorageScope();
    setUser(null);
    setAuthState("anonymous");
    setBootStage("login");
    setSettings({ ...DEFAULT_SETTINGS });
    setHistory([]);
    setCurrentResult(null);
    setSummaryTab("records");
    setAuthNotice("已退出登录。换账号登录后看到的是各自的简历与记录。");
  }

  const THEMES = [
    { key: "green", label: "青玉绿", color: "#0f766e" },
    { key: "ocean", label: "深海蓝", color: "#2d6bc6" },
    { key: "rose", label: "蔷薇玫", color: "#b74c70" },
    { key: "gold", label: "琥珀金", color: "#a66b12" },
    { key: "black", label: "曜石黑", color: "#141a20" },
    { key: "white", label: "纯净白", color: "#ffffff" }
  ];
  const themeIndex = THEMES.findIndex((item) => item.key === theme);
  const currentTheme = THEMES[(themeIndex >= 0 ? themeIndex : 0)];

  if (bootStage === "splash" || authState === "checking") {
    return (
      <>
        <SplashView
          onEnter={
            // 还在确认登录态时不给入口，避免"刚点进入又被弹回登录页"
            authState === "checking"
              ? undefined
              : () => {
                  setBootStage("login");
                }
          }
        />
        <EmbedNotice />
      </>
    );
  }

  if (authState !== "authed" || !user) {
    return (
      <>
        <LoginView onAuthed={handleAuthed} notice={authNotice} />
        <EmbedNotice />
      </>
    );
  }

  // 完成引导：标记已走过引导。带 result 时是"边引导边面试"的收尾，
  // 直接落到复盘报告页——否则首次访客做完第一场只看到工作台上的卡片，
  // 整场面试唯一的高价值产出（报告）被藏在一次点击之后。
  function completeOnboarding(result) {
    markOnboarded();
    if (result) {
      handleFinish(result);
      return;
    }
    setPage("workbench");
  }

  function goPage(key) {
    if (key === "onboarding") {
      setOnboardingStep(1);
      setPage("onboarding");
      return;
    }
    setPage(key);
    if (key === "records" && !currentResult) setSummaryTab("records");
  }

  function saveConfig(nextSettings) {
    saveSettings(nextSettings);
    setSettings(nextSettings);
  }

  function startInterviewFromResume(nextSettings) {
    saveConfig(nextSettings);
    setCurrentResult(null);
    setPage("interview");
  }

  function handleFinish(result) {
    setHistory(loadHistory());
    setCurrentResult(result);
    setSummaryTab("report");
    setPage("records");
  }

  function handleDelete(id) {
    const next = deleteResult(id);
    setHistory(next);
    if (currentResult?.id === id) setCurrentResult(null);
  }

  // 一键回到“全新访客”：记录、设置与语音告知确认都在本机，清掉即彻底退出。
  function handleClearLocalData() {
    const confirmed = window.confirm("确认清除本机数据？面试记录、设置与语音告知确认都会被删除，且无法恢复。");
    if (!confirmed) return;
    clearLocalData();
    saveTheme(theme);
    setSettings({ ...DEFAULT_SETTINGS });
    setHistory([]);
    setCurrentResult(null);
    setSummaryTab("records");
  }

  const recordsPage = (
    <div className="records-page">
      <div className="records-toolbar">
        <button
          className={summaryTab === "report" ? "active" : ""}
          onClick={() => setSummaryTab("report")}
          disabled={!currentResult}
        >
          本场复盘报告
        </button>
        <button
          className={summaryTab === "records" ? "active" : ""}
          onClick={() => setSummaryTab("records")}
        >
          最近 7 场记录
        </button>
      </div>
      {summaryTab === "report" && currentResult ? (
        <ReportView
          result={currentResult}
          onBack={() => setSummaryTab("records")}
          onNew={() => goPage("simulate")}
        />
      ) : (
        <HistoryView
          history={history}
          onOpen={(result) => {
            setCurrentResult(result);
            setSummaryTab("report");
          }}
          onDelete={handleDelete}
          onClear={handleClearLocalData}
          onNew={() => goPage("simulate")}
        />
      )}
      {summaryTab === "records" ? (
        <AccountDataPanel account={user?.account} onClearLocal={handleClearLocalData} onDeleted={handleLogout} />
      ) : null}
    </div>
  );

  // 页面路由表：新增页面只需在此登记，主区域不再堆叠条件渲染。
  const PAGE_RENDERERS = {
    workbench: () => (
      <WorkbenchPage
        settings={settings}
        history={history}
        onNavigate={goPage}
        onVoiceChange={(voiceName) => saveConfig({ ...settings, voiceName })}
      />
    ),
    resume: () => <ResumeAnalysisPage settings={settings} onSave={saveConfig} onNext={() => goPage("simulate")} />,
    simulate: () => (
      <ResumeSetupView settings={settings} onStart={startInterviewFromResume} onBack={() => goPage("resume")} />
    ),
    model: () => <ApiAccessView settings={settings} standalone onSaved={saveConfig} onNext={saveConfig} />,
    interview: () => <InterviewView settings={settings} onFinish={handleFinish} onExit={() => goPage("simulate")} />,
    records: () => recordsPage
  };

  if (page === "onboarding") {
    return (
      <div className={`onboarding-shell theme-${currentTheme.key}`}>
        <EmbedNotice />
        <header className="onboarding-top">
          <div className="onboarding-brand">
            <img src="/logo.png" alt="logo" />
            <div>
              <b>首次使用引导</b>
              <small>先熟悉 Agent，再进入面试工作台</small>
            </div>
          </div>
          <div className="onboarding-steps">
            {[
              { step: 1, label: "API 接入" },
              { step: 2, label: "面试准备" },
              { step: 3, label: "设备与类型" },
              { step: 4, label: "模拟面试" }
            ].map((item) => (
              <span key={item.step} className={onboardingStep >= item.step ? "done" : ""}>
                <b>{String(item.step).padStart(2, "0")}</b>
                {item.label}
              </span>
            ))}
          </div>
        </header>

        <div className="onboarding-body">
          {onboardingStep === 1 ? (
            <ApiAccessView
              settings={settings}
              allowEmpty
              onBack={handleLogout}
              backLabel="← 退出登录"
              onNext={(next) => {
                saveConfig(next);
                setOnboardingStep(2);
              }}
            />
          ) : null}

          {onboardingStep === 2 ? (
            <ResumeSetupView
              settings={settings}
              eyebrow="前置引导 · 2/4 · 面试准备"
              showModeSelector={false}
              startButtonText="下一步：设备与面试类型"
              onStart={(next) => {
                saveConfig(next);
                setOnboardingStep(3);
              }}
              onBack={() => setOnboardingStep(1)}
            />
          ) : null}

          {onboardingStep === 3 ? (
            <DeviceSetupPage
              settings={settings}
              onBack={() => setOnboardingStep(2)}
              onNext={(next) => {
                saveConfig(next);
                setOnboardingStep(4);
              }}
            />
          ) : null}

          {onboardingStep === 4 ? (
            <InterviewView
              settings={settings}
              onFinish={(result) => completeOnboarding(result)}
              onExit={() => setOnboardingStep(3)}
            />
          ) : null}
        </div>
        <ThemePalette theme={currentTheme.key} onChange={setTheme} />
      </div>
    );
  }

  return (
    <div className={`guide-shell theme-${currentTheme.key}`}>
      <EmbedNotice />
      <aside className="guide-sidebar">
        <div className="guide-logo">
          <span className="logo-badge"><Sparkles size={20} /></span>
          <div>
            <b>AI 面试 Agent</b>
            <small>简历 / 面试 / 复盘</small>
          </div>
        </div>

        <nav className="guide-nav">
          {NAV_GROUPS.map((group) => (
            <div className="guide-group" key={group.title}>
              <div className="guide-group-title">{group.title}</div>
              {group.items.map((item) => {
                const Icon = item.icon;
                const active = page === item.key;
                return (
                  <button
                    key={item.key}
                    className={`guide-nav-item ${active ? "active" : ""}`}
                    onClick={() => goPage(item.key)}
                  >
                    <span className="guide-nav-icon"><Icon size={19} /></span>
                    <span className="guide-nav-copy">
                      <b>{item.label}</b>
                      <small>{item.desc}</small>
                    </span>
                    {active ? <ChevronRight size={15} /> : null}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="guide-side-footer">
          <div className="theme-swatches">
            {THEMES.map((item) => (
              <button
                key={item.key}
                type="button"
                className={currentTheme.key === item.key ? "theme-swatch active" : "theme-swatch"}
                style={{ "--swatch": item.color }}
                onClick={() => setTheme(item.key)}
                title={`页面背景：${item.label}`}
              />
            ))}
          </div>
          <button
            className="guide-theme-btn"
            onClick={() => {
              const next = (themeIndex + 1) % THEMES.length;
              setTheme(THEMES[next].key);
            }}
            title="切换页面颜色"
          >
            <Palette size={15} />
            页面颜色：{currentTheme.label}
          </button>
          <div>
            <ShieldCheck size={13} />
            {dataFlowCompact}
          </div>
          <div className="guide-account" title={user?.account}>
            <UserRound size={13} />
            <span>{user?.account || "未登录"}</span>
          </div>
          <button className="guide-logout" onClick={handleLogout}>
            <LogOut size={14} />
            退出登录
          </button>
        </div>
      </aside>

      <main className="guide-content">
        {PAGE_RENDERERS[page]?.()}
      </main>
      <ThemePalette theme={currentTheme.key} onChange={setTheme} />
    </div>
  );
}
