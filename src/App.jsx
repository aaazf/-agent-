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
  Sparkles
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
import { deleteResult, loadHistory, loadSettings, saveSettings } from "./lib/storage.js";

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
  const [authed, setAuthed] = useState(false);
  const [theme, setTheme] = useState("black");
  const [page, setPage] = useState("workbench");
  const [settings, setSettings] = useState(() => loadSettings());
  const [history, setHistory] = useState(() => loadHistory());
  const [currentResult, setCurrentResult] = useState(null);
  const [summaryTab, setSummaryTab] = useState("records");
  const [onboardingStep, setOnboardingStep] = useState(1);

  useEffect(() => {
    localStorage.setItem("guide-theme", theme);
  }, [theme]);

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

  if (bootStage === "splash") {
    return (
      <SplashView
        onEnter={() => {
          setBootStage("login");
        }}
      />
    );
  }

  if (!authed) {
    return (
      <LoginView
        onLogin={() => {
          setAuthed(true);
          if (localStorage.getItem("agent-onboarded") === "1") {
            setPage("workbench");
          } else {
            setPage("onboarding");
            setOnboardingStep(1);
          }
        }}
      />
    );
  }

  function completeOnboarding() {
    localStorage.setItem("agent-onboarded", "1");
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

  if (page === "onboarding") {
    return (
      <div className={`onboarding-shell theme-${currentTheme.key}`}>
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
              onBack={() => {
                setAuthed(false);
                setBootStage("login");
              }}
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
              onFinish={(result) => {
                setHistory(loadHistory());
                setCurrentResult(result);
                setSummaryTab("report");
                completeOnboarding();
              }}
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
            数据仅保存在当前浏览器
          </div>
          <button className="guide-logout" onClick={() => setAuthed(false)}>
            <LogOut size={14} />
            退出登录
          </button>
        </div>
      </aside>

      <main className="guide-content">
        {page === "workbench" ? (
          <WorkbenchPage
            settings={settings}
            history={history}
            onNavigate={goPage}
            onVoiceChange={(voiceName) => saveConfig({ ...settings, voiceName })}
          />
        ) : null}

        {page === "resume" ? (
          <ResumeAnalysisPage
            settings={settings}
            onSave={saveConfig}
            onNext={() => goPage("simulate")}
          />
        ) : null}

        {page === "simulate" ? (
          <ResumeSetupView
            settings={settings}
            onStart={startInterviewFromResume}
            onBack={() => goPage("resume")}
          />
        ) : null}

        {page === "model" ? (
          <ApiAccessView
            settings={settings}
            standalone
            onSaved={saveConfig}
            onNext={saveConfig}
          />
        ) : null}

        {page === "interview" ? (
          <InterviewView
            settings={settings}
            onFinish={handleFinish}
            onExit={() => goPage("simulate")}
          />
        ) : null}

        {page === "records" ? (
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
                onNew={() => goPage("simulate")}
              />
            )}
          </div>
        ) : null}
      </main>
      <ThemePalette theme={currentTheme.key} onChange={setTheme} />
    </div>
  );
}
