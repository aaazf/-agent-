import { useMemo } from "react";
import {
  BarChart3,
  ChevronRight,
  Clock3,
  Download,
  FileText,
  History,
  Plus,
  Trash2,
  TrendingUp,
  Trophy
} from "lucide-react";
import { DIMENSIONS, MAX_RESULTS, formatTime } from "../lib/storage.js";

function downloadJson(list) {
  const blob = new Blob([JSON.stringify(list, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `面试记录-${list.length}场.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

function MiniBar({ value, label, best }) {
  return (
    <div className="mini-bar-row">
      <span>{label}</span>
      <div className="mini-bar-track">
        <div
          className={`mini-bar-fill ${value === best ? "best" : ""}`}
          style={{ width: `${Math.max(2, value)}%` }}
        />
      </div>
      <b>{value}</b>
    </div>
  );
}

export default function HistoryView({ history, onOpen, onDelete, onNew, onClear }) {
  const latest = history[0];
  const previous = history[1];
  const average = useMemo(() => {
    if (!history.length) return null;
    const sums = {};
    DIMENSIONS.forEach((d) => {
      sums[d.key] = history.reduce((acc, item) => acc + (item.evaluation?.scores?.[d.key] || 0), 0) / history.length;
    });
    return sums;
  }, [history]);

  if (!history.length) {
    return (
      <div className="view empty-view">
        <div className="empty-icon">
          <History size={30} />
        </div>
        <h1>还没有面试记录</h1>
        <p>完成一场面试后会保存在这里，最多保留最近 {MAX_RESULTS} 场，用于查看进步差异。</p>
        <button className="primary-btn" onClick={onNew}>
          <Plus size={18} />
          开始第一场面试
        </button>
      </div>
    );
  }

  const overallScores = history.map((item) => item.evaluation?.overall || 0);
  const maxOverall = Math.max(...overallScores);
  const minOverall = Math.min(...overallScores);
  const points = overallScores.map((score, index) => {
    const x = 8 + (history.length === 1 ? 50 : (index / (history.length - 1)) * 184);
    const y = 118 - ((score - Math.max(0, minOverall - 5)) / Math.max(1, maxOverall + 5 - Math.max(0, minOverall - 5))) * 100;
    return `${x},${Math.max(4, Math.min(118, y))}`;
  });

  return (
    <div className="view history-view">
      <div className="view-intro">
        <div>
          <div className="eyebrow">本地记录 · 最多 {MAX_RESULTS} 场</div>
          <h1>7 场对比</h1>
          <p>看总分变化，也看每个维度的涨跌；停顿缓冲次数会单独记录，不计入减分。</p>
        </div>
        <div className="intro-actions">
          <button className="ghost-btn" onClick={() => downloadJson(history)}>
            <Download size={16} />
            导出全部 JSON
          </button>
          {onClear ? (
            <button className="ghost-btn danger" onClick={onClear}>
              <Trash2 size={16} />
              清除本机数据
            </button>
          ) : null}
          <button className="primary-btn" onClick={onNew}>
            <Plus size={17} />
            新面试
          </button>
        </div>
      </div>

      <div className="history-grid">
        <section className="panel trend-panel">
          <div className="section-title">
            <TrendingUp size={17} />
            综合得分趋势
          </div>
          <div className="spark-wrap">
            <svg className="sparkline" viewBox="0 0 200 130" role="img" aria-label="综合得分趋势">
              <line x1="8" y1="122" x2="192" y2="122" />
              {overallScores.map((score, index) => {
                const x = history.length === 1 ? 100 : 8 + (index / (history.length - 1)) * 184;
                return (
                  <g key={`${score}-${index}`}>
                    <line x1={x} y1="122" x2={x} y2="118" />
                    <text x={x - 8} y="132" fontSize="8" fill="currentColor">
                      {index + 1}
                    </text>
                  </g>
                );
              })}
              <polyline points={points.join(" ")} fill="none" />
              {overallScores.map((score, index) => {
                const x = history.length === 1 ? 100 : 8 + (index / (history.length - 1)) * 184;
                const y = 118 - ((score - Math.max(0, minOverall - 5)) / Math.max(1, maxOverall + 5 - Math.max(0, minOverall - 5))) * 100;
                return <circle key={`${score}-${index}`} cx={x} cy={Math.max(4, Math.min(118, y))} r="3.4" />;
              })}
            </svg>
            <div className="spark-labels">
              <span>第 1 场</span>
              <span>最新第 {history.length} 场</span>
            </div>
          </div>
          <div className="trend-legend">
            <span>
              <b>{maxOverall}</b> 最高分
            </span>
            <span>
              <b>{Math.round(overallScores.reduce((a, b) => a + b, 0) / overallScores.length)}</b> 平均分
            </span>
            <span>
              <b>{latest.evaluation.overall}</b> 最近一场
            </span>
          </div>
        </section>

        {latest && average ? (
          <section className="panel latest-vs-panel">
            <div className="section-title">
              <BarChart3 size={17} />
              最新 vs 7 场平均
            </div>
            <div className="mini-bars">
              {DIMENSIONS.map((dim) => {
                const value = latest.evaluation.scores[dim.key] || 0;
                const avg = Math.round(average[dim.key]);
                return (
                  <div className="double-bar" key={dim.key}>
                    <div>
                      <span className="bar-caption">{dim.label}</span>
                      <div className="bar-value">
                        <span>
                          <i className="dot-new" /> 本场 {value}
                        </span>
                        <span>
                          <i className="dot-avg" /> 平均 {avg}
                        </span>
                      </div>
                    </div>
                    <MiniBar value={value} label="" best={Math.max(value, avg)} />
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}
      </div>

      {latest && previous ? (
        <section className="panel delta-panel">
          <div className="section-title">
            <Trophy size={17} />
            最近两场变化
          </div>
          <div className="delta-grid">
            {DIMENSIONS.map((dim) => {
              const current = latest.evaluation.scores[dim.key];
              const old = previous.evaluation.scores[dim.key];
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

      <section className="history-list">
        <div className="section-title list-title">
          <FileText size={17} />
          全部记录
        </div>
        {history.map((item, index) => {
          const prevScore = history[index + 1]?.evaluation?.overall;
          const diff = prevScore == null ? null : item.evaluation.overall - prevScore;
          return (
            <article className="history-card" key={item.id} onClick={() => onOpen(item)}>
              <div className="history-main">
                <div className={`history-score ${item.evaluation.overall >= 70 ? "good" : item.evaluation.overall >= 45 ? "mid" : "low"}`}>
                  <b>{item.evaluation.overall}</b>
                  <small>综合</small>
                </div>
                <div className="history-info">
                  <div className="history-title">
                    <b>{item.settings.role}</b>
                    <span>{item.settings.direction} · {item.settings.style}</span>
                    {item.stats?.modelUsed ? <i className="model-chip">模型提问</i> : <i className="model-chip">本地</i>}
                  </div>
                  <div className="history-sub">
                    <span>{formatTime(item.createdAt)}</span>
                    <span>完成 {item.history.length}/{item.settings.questionCount} 题</span>
                    <span><Clock3 size={13} /> 缓冲 {item.stats?.pauseCount || 0} 次</span>
                    {diff != null ? (
                      <span className={diff >= 0 ? "diff-up" : "diff-down"}>
                        {diff > 0 ? `+${diff}` : diff} vs 上轮
                      </span>
                    ) : null}
                  </div>
                </div>
              </div>
              <div className="history-actions">
                <button
                  className="small-btn icon-btn"
                  aria-label="删除记录"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (window.confirm("确认删除这条记录？")) onDelete(item.id);
                  }}
                >
                  <Trash2 size={15} />
                </button>
                <ChevronRight size={18} />
              </div>
            </article>
          );
        })}
      </section>
    </div>
  );
}
