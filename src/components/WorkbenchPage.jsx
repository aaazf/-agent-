import {
  ArrowRight,
  AudioLines,
  BarChart3,
  Bot,
  Cpu,
  FileStack,
  Mic2,
  Plus,
  RadioTower,
  ScanText,
  ShieldCheck,
  Sparkles
} from "lucide-react";
import { formatTime } from "../lib/storage.js";
import useHostedQuota, { displayModelName, modelAvailable } from "../hooks/useHostedQuota.js";
import { dataFlowCompact } from "../lib/privacy.js";

export default function WorkbenchPage({ settings, history, onNavigate, onVoiceChange }) {
  const hosted = useHostedQuota();
  const modelReady = modelAvailable({ settings, hosted });
  const modelLabel = displayModelName({ settings, hosted });
  const latest = history[0];

  return (
    <div className="workbench-page">
      <div className="workbench-hero">
        <div>
          <div className="eyebrow">面试中心</div>
          <h1>今天想练哪一场？</h1>
          <p>上传简历、接入模型后即可开始。评分只在整场面试结束后给出。</p>
        </div>
        <div className="hero-actions">
          <button className="onboarding-entry-btn" onClick={() => onNavigate("onboarding")}>
            <Sparkles size={16} />
            进入首次引导（API 接入开始）
          </button>
          <button className="primary-btn hero-start" onClick={() => onNavigate("simulate")}>
            <Sparkles size={18} />
            开始模拟面试
          </button>
        </div>
      </div>

      <div className="module-grid">
        <button className="module-card" onClick={() => onNavigate("resume")}>
          <span className="module-icon teal"><FileStack size={22} /></span>
          <div>
            <b>简历分析</b>
            <small>导入 PDF / DOCX / TXT，识别姓名、项目与技能</small>
          </div>
          <ArrowRight size={17} />
        </button>

        <button className="module-card" onClick={() => onNavigate("simulate")}>
          <span className="module-icon indigo"><Mic2 size={22} /></span>
          <div>
            <b>模拟面试</b>
            <small>文字面试或面对面实时语音 / 视频面试</small>
          </div>
          <ArrowRight size={17} />
        </button>

        <button className="module-card" onClick={() => onNavigate("records")}>
          <span className="module-icon amber"><BarChart3 size={22} /></span>
          <div>
            <b>面试记录</b>
            <small>最近 7 场报告与维度差异</small>
          </div>
          <ArrowRight size={17} />
        </button>

        <button className="module-card" onClick={() => onNavigate("model")}>
          <span className="module-icon slate"><Cpu size={22} /></span>
          <div>
            <b>模型接入</b>
            <small>选择服务商与模型，测试接入状态</small>
          </div>
          <ArrowRight size={17} />
        </button>
      </div>

      <div className="workbench-bottom">
        <section className="panel status-panel">
          <div className="section-title">
            <RadioTower size={17} />
            系统状态
          </div>
          <div className="status-grid">
            <div>
              <span>模型引擎</span>
              <b>{modelReady ? modelLabel : "本地题库"}</b>
              <small>{modelReady ? (settings?.apiKey?.trim() ? "已接入" : "本站共享额度") : "建议到模型接入页配置"}</small>
            </div>
            <div>
              <span>面试模式</span>
              <b>{settings.interviewMode === "text" ? "文字面试" : "语音 / 视频"}</b>
              <small>可在模拟面试页切换</small>
            </div>
            <div>
              <span>简历状态</span>
              <b>{settings.resume?.trim() ? "已提供" : "未上传"}</b>
              <small>{settings.resume?.trim().length || 0} 字内容</small>
            </div>
            <div>
              <span>结果记录</span>
              <b>{history.length} / 7 场</b>
              <small>自动保留最近 7 场</small>
            </div>
          </div>
          <div className="voice-change-card">
            <AudioLines size={18} />
            <div>
              <b>面试官声音</b>
              <small>选择自然神经音色，语音面试时自动使用</small>
            </div>
            <select value={settings.voiceName || "auto"} onChange={(e) => onVoiceChange(e.target.value)}>
              <option value="auto">自动选择自然中文音色</option>
              <option value="XiaoxiaoNeural">晓晓 · 温柔女声</option>
              <option value="YunxiNeural">云希 · 温和男声</option>
              <option value="XiaoyiNeural">晓伊 · 年轻女声</option>
              <option value="YunjianNeural">云健 · 沉稳男声</option>
              <option value="YunyangNeural">云扬 · 专业男声</option>
              <option value="system">跟随系统默认语音</option>
            </select>
          </div>
        </section>

        <section className="panel recent-panel">
          <div className="section-title">
            <Bot size={17} />
            最近练习
          </div>
          {latest ? (
            <button className="recent-card" onClick={() => onNavigate("records")}>
              <div>
                <b>{latest.settings.role}</b>
                <small>{formatTime(latest.createdAt)} · 完成 {latest.history.length}/{latest.settings.questionCount} 题</small>
              </div>
              <div className={`recent-score ${latest.evaluation.overall >= 70 ? "good" : "mid"}`}>
                <b>{latest.evaluation.overall}</b>
              </div>
            </button>
          ) : (
            <div className="recent-empty">
              <ScanText size={26} />
              <p>还没有面试记录，完成第一场后这里会出现成长卡片。</p>
              <button className="small-btn" onClick={() => onNavigate("simulate")}>
                <Plus size={15} />
                开始第一场
              </button>
            </div>
          )}
          <div className="privacy-note">
            <ShieldCheck size={14} />
            {dataFlowCompact}
          </div>
        </section>
      </div>
    </div>
  );
}
