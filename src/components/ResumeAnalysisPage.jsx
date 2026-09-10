import { useEffect, useRef, useState } from "react";
import { FileText, LoaderCircle, Save, ScanText, UploadCloud } from "lucide-react";
import { analyzeResumeLocal } from "../lib/resume.js";
import { analyzeResumeWithModel } from "../lib/model.js";

export default function ResumeAnalysisPage({ settings, onSave, onNext }) {
  const [resume, setResume] = useState(settings.resume || "");
  const [analysis, setAnalysis] = useState(null);
  const [status, setStatus] = useState("idle");
  const [msg, setMsg] = useState("");
  const fileRef = useRef(null);

  async function analyze(text, nextSettings = settings) {
    if (!text?.trim()) return;
    setStatus("loading");
    const local = analyzeResumeLocal(text);
    let result = local;
    if (nextSettings.apiKey?.trim() && nextSettings.modelName?.trim()) {
      try {
        result = await analyzeResumeWithModel({ settings: nextSettings, text });
      } catch {
        result = local;
      }
    }
    setAnalysis(result);
    setStatus("ok");
    setMsg(result.source === "model" ? "模型已完成简历结构化分析" : "本地规则已完成基础识别");
  }

  async function importFile(file) {
    if (!file) return;
    const lower = file.name.toLowerCase();
    if (!/\.(pdf|docx|txt)$/.test(lower)) {
      setMsg("仅支持 PDF / DOCX / TXT");
      return;
    }
    setStatus("loading");
    try {
      let text;
      if (lower.endsWith(".txt")) {
        text = await file.text();
      } else {
        const b64 = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
        const res = await fetch("/api/parse-resume", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: file.name, dataBase64: b64 })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "解析失败");
        text = data.text;
      }
      setResume(text);
      await analyze(text);
    } catch (err) {
      setStatus("error");
      setMsg(err.message || "解析失败");
    }
  }

  useEffect(() => {
    if (settings.resume?.trim()) analyze(settings.resume);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function save() {
    onSave({ ...settings, resume, resumeAnalysis: analysis });
    onNext();
  }

  return (
    <div className="module-page resume-analysis-page">
      <div className="module-heading">
        <div>
          <div className="eyebrow">简历分析</div>
          <h1>候选人简历画像</h1>
          <p>上传或粘贴简历，自动识别姓名、性别、年限、项目经历、技能，再由面试官围绕项目追问。</p>
        </div>
        <div className="module-heading-note">
          <ScanText size={15} />
          PDF / DOCX / TXT 均在本机解析
        </div>
      </div>

      <div className="resume-analyze-grid">
        <section className="panel">
          <button
            type="button"
            className="resume-import"
            onClick={() => fileRef.current?.click()}
          >
            {status === "loading" ? <LoaderCircle className="spin" size={20} /> : <UploadCloud size={20} />}
            <span>
              <b>{status === "loading" ? "正在解析…" : "上传简历"}</b>
              <small>{msg || "支持 PDF / DOCX / TXT"}</small>
            </span>
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".pdf,.docx,.txt"
            hidden
            onChange={(e) => {
              importFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          <label className="textarea-label">
            <span>简历文本</span>
            <textarea
              rows={12}
              value={resume}
              onChange={(e) => setResume(e.target.value)}
              placeholder="粘贴简历文本，或先上传文件"
            />
          </label>
          <button className="outline-btn" onClick={() => analyze(resume)} disabled={status === "loading"}>
            <ScanText size={15} />
            重新分析
          </button>
          <button className="primary-btn wide save-resume-btn" onClick={save}>
            <Save size={17} />
            保存并进入模拟面试准备
          </button>
        </section>

        <section className="panel analysis-summary-panel">
          <div className="section-title">
            <ScanText size={17} />
            识别结果
          </div>
          {analysis ? (
            <>
              <div className="analysis-facts">
                <div><span>姓名</span><b>{analysis.name || "未识别"}</b></div>
                <div><span>性别</span><b>{analysis.gender || "未知"}</b></div>
                <div><span>年限</span><b>{analysis.years ? `${analysis.years} 年` : "未知"}</b></div>
                <div><span>项目数</span><b>{analysis.projects?.length || 0}</b></div>
              </div>
              <div className="analysis-projects-list">
                <b>项目经历</b>
                {(analysis.projects || []).map((p, i) => (
                  <div key={i}>
                    <strong>{p.title || "未命名项目"}</strong>
                    <p>{p.detail || "暂无描述"}</p>
                  </div>
                ))}
                {!(analysis.projects || []).length ? <p>未识别到明确项目。</p> : null}
              </div>
              <div className="analysis-skills">
                <b>技能</b>
                <div className="skill-tags">
                  {(analysis.skills || []).map((skill) => <span key={skill}>{skill}</span>)}
                  {!(analysis.skills || []).length ? <span>未提取</span> : null}
                </div>
              </div>
            </>
          ) : (
            <div className="analysis-loading">
              <FileText size={18} />
              等待简历内容
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
