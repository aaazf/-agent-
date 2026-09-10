import {
  ArrowLeft,
  BarChart3,
  Bot,
  CheckCircle2,
  Download,
  FileJson,
  Lightbulb,
  Printer,
  RefreshCcw,
  Sparkles,
  Target,
  TrendingUp
} from "lucide-react";
import { DIMENSIONS, formatTime, loadHistory, secondsLabel } from "../lib/storage.js";

function ScoreRing({ value, label, size = 96, tone = "teal" }) {
  const radius = size / 2 - 9;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (value / 100) * circumference;
  return (
    <div className="score-ring" style={{ width: size, height: size }}>
      <svg width={size} height={size}>
        <circle className="ring-track" cx={size / 2} cy={size / 2} r={radius} />
        <circle
          className={`ring-value ${tone}`}
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
        />
      </svg>
      <div className="ring-center">
        <b>{value}</b>
        <small>{label}</small>
      </div>
    </div>
  );
}

function download(filename, content, mime = "application/json") {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

function toMarkdown(result) {
  const { evaluation, history, settings } = result;
  const dims = DIMENSIONS.map((d) => `${d.label}：${evaluation.scores[d.key]}/100`).join("；");
  const lines = [
    `# 模拟面试报告`,
    ``,
    `- 时间：${formatTime(result.createdAt)}`,
    `- 岗位：${settings.role}（${settings.direction}）`,
    `- 面试官风格：${settings.style}`,
    `- 题数：${history.length} / ${settings.questionCount}`,
    `- 总分：${evaluation.overall}/100`,
    `- 维度：${dims}`,
    `- 停顿缓冲：${result.stats.pauseCount} 次`,
    ``,
    `## 总评`,
    evaluation.summary,
    ``,
    `## 优点`,
    ...evaluation.strengths.map((s) => `- ${s}`),
    ``,
    `## 待改进`,
    ...evaluation.improvements.map((s) => `- ${s}`),
    ``,
    `## 问答记录`
  ];
  history.forEach((round, index) => {
    const per = evaluation.perQuestion?.[index];
    lines.push(
      ``,
      `### ${index + 1}. ${round.focus}`,
      ``,
      `**面试官：** ${round.question}`,
      ``,
      `**候选人：** ${round.answer || "（跳过）"}`,
      per ? `**本题得分：** ${per.score}/100` : "",
      per?.issues?.length ? `**问题：** ${per.issues.join("；")}` : "",
      per?.plan ? `**改进方案：** ${per.plan}` : "",
      ``
    );
  });
  return lines.join("\n");
}

export default function ReportView({ result, onBack, onNew }) {
  if (!result) return null;
  const { evaluation, history, stats, settings } = result;
  const prev = loadHistory().find((item) => item.id !== result.id) || null;

  function printPdf() {
    window.print();
  }

  return (
    <div className="view report-view printable-area">
      <div className="report-header no-print">
        <button className="ghost-btn" onClick={onBack}>
          <ArrowLeft size={16} />
          返回记录
        </button>
        <div className="report-actions">
          <button className="small-btn" onClick={onNew}>
            <RefreshCcw size={15} />
            再来一轮
          </button>
          <button className="small-btn" onClick={() => download(`面试报告-${settings.role}.json`, JSON.stringify(result, null, 2), "application/json")}>
            <FileJson size={15} />
            导出 JSON
          </button>
          <button className="small-btn" onClick={() => download(`面试报告-${settings.role}.md`, toMarkdown(result), "text/markdown")}>
            <Download size={15} />
            导出 Markdown
          </button>
          <button className="primary-btn" onClick={printPdf}>
            <Printer size={16} />
            打印 / PDF
          </button>
        </div>
      </div>

      <div className="report-hero">
        <div>
          <div className="eyebrow">
            {formatTime(result.createdAt)} · {settings.role}
          </div>
          <h1>本场复盘报告</h1>
          <p>
            {settings.direction} · {settings.style} · 完成 {history.length}/{settings.questionCount} 题
            {stats.modelUsed ? " · 模型驱动提问" : " · 本地题库"}
            {stats.earlyEnded ? " · 提前结束" : ""}
          </p>
        </div>
        <ScoreRing value={evaluation.overall} label="综合得分" />
      </div>

      <div className="report-grid">
        <section className="panel score-panel">
          <div className="section-title">
            <BarChart3 size={17} />
            多维评分
          </div>
          <div className="score-bars">
            {DIMENSIONS.map((dim) => {
              const value = evaluation.scores[dim.key];
              return (
                <div className="score-bar-row" key={dim.key}>
                  <span>{dim.label}</span>
                  <div className="score-track">
                    <div className="score-fill" style={{ width: `${value}%` }} />
                  </div>
                  <b>{value}</b>
                </div>
              );
            })}
          </div>
          <div className="result-meta">
            <span>
              时长 {secondsLabel(stats.durationMs || result.createdAt - (result.startedAt || result.createdAt))}
            </span>
            <span>停顿缓冲 {stats.pauseCount} 次</span>
            <span>使用提示 {stats.hintsUsed} 次</span>
          </div>
        </section>

        <section className="panel summary-panel">
          <div className="section-title">
            <Bot size={17} />
            面试官总评
          </div>
          <p className="eval-summary">{evaluation.summary}</p>
          <div className="two-col-feedback">
            <div className="strength-block">
              <div className="section-title">
                <CheckCircle2 size={16} />
                优点
              </div>
              <ul>
                {evaluation.strengths.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
            <div className="improve-block">
              <div className="section-title">
                <Lightbulb size={16} />
                待改进
              </div>
              <ul>
                {evaluation.improvements.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          </div>
        </section>
      </div>

      {prev ? (
        <section className="panel delta-panel">
          <div className="section-title">
            <TrendingUp size={17} />
            与上一场对比
          </div>
          <div className="delta-grid">
            {DIMENSIONS.map((dim) => {
              const current = evaluation.scores[dim.key];
              const old = prev.evaluation.scores[dim.key];
              const diff = current - old;
              return (
                <div className={`delta-cell ${diff > 0 ? "up" : diff < 0 ? "down" : "same"}`} key={dim.key}>
                  <span>{dim.label}</span>
                  <b>{diff > 0 ? `+${diff}` : diff}</b>
                  <small>上轮 {old}</small>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      <section className="panel qa-panel">
        <div className="section-title">
          <Target size={17} />
          逐题回顾
        </div>
        <div className="qa-list">
          {history.map((round, index) => (
            <article className="qa-item" key={`${round.question}-${index}`}>
              <div className="qa-number">{String(index + 1).padStart(2, "0")}</div>
              <div className="qa-content">
                {evaluation.perQuestion?.[index] ? (
                  <div className="qa-score-line">
                    <div className={`qa-score ${evaluation.perQuestion[index].score >= 70 ? "good" : "low"}`}>
                      <b>{evaluation.perQuestion[index].score}</b>
                      <span>本题得分</span>
                    </div>
                    <div className="qa-improve">
                      <b>可以改进的地方</b>
                      <span>{evaluation.perQuestion[index].issues?.join("；") || "回答整体完整"}</span>
                      <b>下次怎么做</b>
                      <span>{evaluation.perQuestion[index].plan || "保持并继续深化细节"}</span>
                    </div>
                  </div>
                ) : null}
                <div className="qa-q">
                  <span>{round.focus}</span>
                  <p>{round.question}</p>
                </div>
                <div className="qa-a">
                  <span>{round.answer ? "回答" : "跳过"}</span>
                  <p>{round.answer || "本轮未作答"}</p>
                </div>
                <div className="qa-meta">
                  <span>用时 {secondsLabel(round.durationMs)}</span>
                  {round.pauseCount ? <span>缓冲 {round.pauseCount} 次</span> : null}
                  {round.usedHint ? <span>使用提示</span> : null}
                  <span>{round.source === "model" ? "模型出题" : "本地题库"}</span>
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
