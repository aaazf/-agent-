import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  FileText,
  LoaderCircle,
  MessageSquareText,
  Play,
  RefreshCw,
  ScanText,
  UploadCloud,
  UserRound,
  Video
} from "lucide-react";
import { analyzeResumeLocal } from "../lib/resume.js";
import { analyzeResumeWithModel } from "../lib/model.js";

const DIRECTIONS = [
  "互联网",
  "电商",
  "金融",
  "教育",
  "企业服务",
  "医疗健康",
  "游戏",
  "智能制造",
  "交通物流",
  "本地生活",
  "广告营销",
  "公共服务",
  "其他"
];
const ROLES = [
  "前端工程师",
  "后端工程师",
  "全栈工程师",
  "算法工程师",
  "产品经理",
  "数据分析师",
  "商业分析师",
  "BI 工程师",
  "数据产品经理",
  "数据运营",
  "数据开发工程师",
  "测试工程师"
];
const STYLES = ["温和引导", "标准专业", "追问较深", "高压快节奏"];

function InterviewModePicker({ mode, onChange }) {
  return (
    <div className="mode-picker">
      <button
        type="button"
        className={mode === "text" ? "mode-card active" : "mode-card"}
        onClick={() => onChange("text")}
      >
        <MessageSquareText size={22} />
        <span>
          <b>文字面试</b>
          <small>输入回答，回车发送，适合快速练习</small>
        </span>
      </button>
      <button
        type="button"
        className={mode === "voice" ? "mode-card active" : "mode-card"}
        onClick={() => onChange("voice")}
      >
        <Video size={22} />
        <span>
          <b>面对面语音 / 视频面试</b>
          <small>自动听答，说完自动进入下一题，可开启摄像头</small>
        </span>
      </button>
    </div>
  );
}

export default function ResumeSetupView({
  settings,
  onStart,
  onBack,
  eyebrow = "03 · 面试准备",
  showModeSelector = true,
  startButtonText = "开始模拟面试"
}) {
  const [form, setForm] = useState({ ...settings });
  const fileRef = useRef(null);
  const [uploadState, setUploadState] = useState("idle");
  const [uploadMsg, setUploadMsg] = useState("");
  const [analysis, setAnalysis] = useState(settings.resumeAnalysis || null);
  const [analysisState, setAnalysisState] = useState(settings.resumeAnalysis ? "ok" : "idle");
  const set = (key, value) => setForm((prev) => ({ ...prev, [key]: value }));

  useEffect(() => {
    if (form.resume?.trim() && !settings.resumeAnalysis) {
      const local = analyzeResumeLocal(form.resume);
      if (local.rawLength) {
        setAnalysis(local);
        setAnalysisState("ok");
      }
    }
    // 只在进入准备页时做一次本地识别，避免自动消耗模型额度
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runResumeAnalysis(nextSettings, text) {
    if (!text?.trim()) {
      setAnalysis(null);
      return;
    }
    setAnalysisState("loading");
    try {
      const local = analyzeResumeLocal(text);
      let result = local;
      if (nextSettings?.apiKey?.trim() && nextSettings?.modelName?.trim()) {
        try {
          result = await analyzeResumeWithModel({ settings: nextSettings, text });
        } catch {
          result = local;
        }
      }
      setAnalysis(result);
      setAnalysisState("ok");
      return result;
    } catch {
      setAnalysis(null);
      setAnalysisState("error");
      return null;
    }
  }

  async function importResume(file) {
    if (!file) return;
    const lower = file.name.toLowerCase();
    if (!lower.endsWith(".pdf") && !lower.endsWith(".docx") && !lower.endsWith(".txt")) {
      setUploadMsg("仅支持 PDF / DOCX / TXT 格式");
      return;
    }
    if (file.size > 12 * 1024 * 1024) {
      setUploadMsg("文件过大，请控制在 12MB 以内");
      return;
    }
    setUploadState("loading");
    setUploadMsg(`正在解析 ${file.name}…`);
    try {
      let text;
      if (lower.endsWith(".txt")) {
        text = await file.text();
      } else {
        const dataBase64 = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const raw = String(reader.result || "");
            resolve(raw.slice(raw.indexOf(",") + 1));
          };
          reader.onerror = () => reject(new Error("读取文件失败"));
          reader.readAsDataURL(file);
        });
        const res = await fetch("/api/parse-resume", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: file.name, dataBase64 })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "解析失败");
        text = data.text || "";
      }
      if (!text.trim()) {
        throw new Error("未从文件中识别到文本，请检查是否为扫描版 PDF");
      }
      set("resume", text.trim());
      setUploadState("ok");
      setUploadMsg(`已导入 ${file.name}（${text.trim().length} 字）`);
      await runResumeAnalysis(form, text.trim());
    } catch (err) {
      setUploadState("error");
      setUploadMsg(err.message || "导入失败");
    }
  }

  async function refreshAnalysis() {
    await runResumeAnalysis(form, form.resume);
  }

  return (
    <div className="module-page resume-page">
      <div className="module-heading">
        <div>
          <div className="eyebrow">{eyebrow}</div>
          <h1>岗位与简历材料</h1>
          <p>这些材料会注入模型提示词；没有模型 Key 时也用于本地出题与规则评分。</p>
        </div>
        <button className="ghost-btn" onClick={onBack}>
          ← 返回 API 接入
        </button>
      </div>

      <div className="resume-layout">
        <div className="resume-main">
          <section className="panel">
            <div className="api-section-title">
              <UserRound size={18} />
              <div>
                <b>岗位定位</b>
                <small>选择业务方向与目标岗位</small>
              </div>
            </div>
            <div className="form-grid two resume-basic">
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
            <div className="form-grid two resume-basic">
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
                  <button type="button" onClick={() => set("questionCount", Math.max(3, form.questionCount - 1))}>
                    −
                  </button>
                  <span>{form.questionCount}</span>
                  <button type="button" onClick={() => set("questionCount", Math.min(8, form.questionCount + 1))}>
                    +
                  </button>
                </div>
              </label>
            </div>
            {showModeSelector ? (
              <div className="mode-picker-wrap">
                <label className="mode-label">面试形式</label>
                <InterviewModePicker
                  mode={form.interviewMode || "voice"}
                  onChange={(value) => set("interviewMode", value)}
                />
              </div>
            ) : null}
          </section>

          <section className="panel">
            <div className="api-section-title">
              <FileText size={18} />
              <div>
                <b>简历 / 项目经历</b>
                <small>支持上传 PDF / DOCX / TXT，也可直接粘贴文本</small>
              </div>
            </div>
            <button
              type="button"
              className={`resume-import ${uploadState === "error" ? "import-error" : ""}`}
              onClick={() => fileRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                importResume(e.dataTransfer.files?.[0]);
              }}
            >
              {uploadState === "loading" ? <LoaderCircle className="spin" size={20} /> : <UploadCloud size={20} />}
              <span>
                <b>{uploadState === "loading" ? "正在解析简历…" : "点击或拖拽导入简历"}</b>
                <small>{uploadMsg || "文件只在本机解析，解析结果会填入下方文本框，可继续编辑"}</small>
              </span>
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".pdf,.docx,.txt"
              hidden
              onChange={(e) => {
                importResume(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            <label className="textarea-label">
              <span>简历内容</span>
              <textarea
                value={form.resume}
                rows={8}
                onChange={(e) => {
                  set("resume", e.target.value);
                  setAnalysis(null);
                  setAnalysisState("idle");
                }}
                placeholder="写清年限、技术栈、主要项目、量化结果"
              />
            </label>
          </section>

          <section className="panel resume-analysis-card">
            <div className="api-section-title">
              <ScanText size={18} />
              <div>
                <b>候选人画像识别</b>
                <small>自动提取姓名、性别、年限、技能和项目经历；已接入模型时由模型做结构化归纳</small>
              </div>
              <button type="button" className="small-btn analysis-btn" onClick={refreshAnalysis} disabled={analysisState === "loading" || !form.resume.trim()}>
                {analysisState === "loading" ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}
                {analysisState === "loading" ? "分析中…" : "重新分析"}
              </button>
            </div>

            {analysisState === "loading" ? (
              <div className="analysis-loading">
                <LoaderCircle className="spin" size={18} />
                正在读取简历并整理候选人画像…
              </div>
            ) : analysis ? (
              <div className="analysis-grid">
                <div className="analysis-facts">
                  <div>
                    <span>姓名</span>
                    <b>{analysis.name || "未识别"}</b>
                  </div>
                  <div>
                    <span>性别</span>
                    <b>{analysis.gender || "未知"}</b>
                  </div>
                  <div>
                    <span>年限</span>
                    <b>{analysis.years ? `${analysis.years} 年` : "未识别"}</b>
                  </div>
                  <div>
                    <span>项目数</span>
                    <b>{analysis.projects?.length || 0}</b>
                  </div>
                </div>
                <div className="analysis-skills">
                  <div>
                    <b>技能标签</b>
                    <div className="skill-tags">
                      {(analysis.skills?.length ? analysis.skills : ["未提取到明确技能"]).map((skill) => (
                        <span key={skill}>{skill}</span>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="analysis-projects">
                  <b>识别到的项目经历</b>
                  {analysis.projects?.length ? (
                    analysis.projects.map((project, index) => (
                      <div key={`${project.title}-${index}`}>
                        <strong>{project.title}</strong>
                        <p>{project.detail || project.tech || "可进入面试后补充追问"}</p>
                      </div>
                    ))
                  ) : (
                    <p>未识别到明确项目，建议在简历中补充项目经历或手动粘贴。</p>
                  )}
                </div>
              </div>
            ) : (
              <div className="analysis-empty">
                导入简历或粘贴内容后，点击“重新分析”生成候选人画像。
              </div>
            )}
          </section>

          <section className="panel">
            <div className="api-section-title">
              <FileText size={18} />
              <div>
                <b>目标岗位 JD</b>
                <small>用于匹配度评分和针对性追问</small>
              </div>
            </div>
            <label className="textarea-label">
              <span>JD 内容</span>
              <textarea
                value={form.jd}
                rows={8}
                onChange={(e) => set("jd", e.target.value)}
                placeholder="粘贴或简写岗位职责、技术要求、加分项"
              />
            </label>
          </section>
        </div>

        <aside className="panel resume-side">
          <div className="summary-title">本场预览</div>
          <div className="selected-model compact-summary">
            <div>
              <b>{form.role}</b>
              <small>{form.direction} · {form.style}</small>
            </div>
          </div>
          <div className="summary-rows">
            <div>
              <span>简历字数</span>
              <b>{form.resume.trim().length}</b>
            </div>
            <div>
              <span>JD 字数</span>
              <b>{form.jd.trim().length}</b>
            </div>
            <div>
              <span>题目上限</span>
              <b>{form.questionCount} 题</b>
            </div>
            <div>
              <span>面试形式</span>
              <b>{form.interviewMode === "text" ? "文字面试" : "语音 / 视频"}</b>
            </div>
            <div>
              <span>缓冲</span>
              <b>{form.bufferEnabled ? `${form.bufferSeconds} 秒` : "关闭"}</b>
            </div>
          </div>
          <button
            className="primary-btn wide next-btn"
            onClick={() => onStart({ ...form, resumeAnalysis: analysis })}
            disabled={!form.resume.trim() || !form.jd.trim()}
          >
            <Play size={17} fill="currentColor" />
            {startButtonText}
          </button>
          {(!form.resume.trim() || !form.jd.trim()) ? (
            <p className="micro-copy">简历和 JD 不能为空，至少写一段简版。</p>
          ) : null}
          <p className="micro-copy">
            <ArrowRight size={13} />
            下一步进入语音面试，模型根据每轮回答判断下一题。
          </p>
        </aside>
      </div>
    </div>
  );
}
