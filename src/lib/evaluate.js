import { DIMENSIONS } from "./storage.js";

const ROLE_KEYWORDS = {
  前端工程师: ["react", "vue", "typescript", "组件", "状态", "性能", "浏览器", "缓存", "工程化", "构建", "css", "dom", "http", "安全", "测试"],
  后端工程师: ["数据库", "缓存", "redis", "mysql", "并发", "线程", "队列", "接口", "分布式", "事务", "幂等", "监控", "日志", "linux", "容器"],
  全栈工程师: ["react", "node", "api", "数据库", "缓存", "部署", "性能", "组件", "架构", "安全", "测试", "监控"],
  算法工程师: ["复杂度", "数据结构", "算法", "特征", "模型", "评估", "指标", "a/b", "样本", "召回", "排序", "调参"],
  产品经理: ["用户", "需求", "指标", "优先级", "场景", "数据", "沟通", "排期", "方案", "竞品", "收益"],
  数据分析师: ["指标", "口径", "ab", "留存", "转化", "漏斗", "回归", "数据", "可视化", "sql", "假设"],
  商业分析师: ["指标", "业务", "增长", "转化", "留存", "ab", "漏斗", "分析", "决策", "复购", "gmv"],
  "BI 工程师": ["数仓", "etl", "报表", "指标", "维度", "bi", "可视化", "调度", "数据质量", "血缘"],
  数据产品经理: ["数据产品", "埋点", "指标", "权限", "ab", "实验", "分析", "需求", "产品", "效率"],
  数据运营: ["活动", "转化", "留存", "复购", "gmv", "渠道", "用户", "漏斗", "监控", "复盘"],
  数据开发工程师: ["数仓", "etl", "调度", "数据质量", "hive", "spark", "flink", "任务", "血缘", "指标"],
  测试工程师: ["用例", "自动化", "回归", "质量", "风险", "覆盖率", "兼容", "环境", "链路", "发布", "缺陷"]
};

const MARKERS = ["首先", "其次", "然后", "最后", "因为", "所以", "背景", "任务", "行动", "结果", "当时", "后来", "我认为", "具体来说", "举个例子"];

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Math.round(value)));
}

export function localEvaluation({ settings, history, stats }) {
  const keywords = ROLE_KEYWORDS[settings.role] || [];
  const jdTokens = [...new Set((settings.jd || "").toLowerCase().match(/[a-z][a-z0-9+/.-]{1,}/g) || [])];
  const answered = history.filter((round) => round.answer && round.answer.trim().length >= 8);
  const answeredCount = answered.length;
  const totalChars = answered.reduce((sum, round) => sum + round.answer.trim().length, 0);
  const avgChars = answeredCount ? totalChars / answeredCount : 0;
  const structureHits = answered.reduce((sum, round) => sum + MARKERS.filter((m) => round.answer.includes(m)).length, 0);
  const keywordHits = answered.reduce((sum, round) => {
    const lower = round.answer.toLowerCase();
    return sum + keywords.filter((k) => lower.includes(k)).length;
  }, 0);
  const jdHits = answered.reduce((sum, round) => {
    const lower = round.answer.toLowerCase();
    return sum + jdTokens.filter((k) => k.length > 2 && lower.includes(k)).length;
  }, 0);

  const communication = clamp(35 + Math.min(35, avgChars / 18) + Math.min(20, structureHits * 2.2) + answeredCount * 2);
  const professional = clamp(25 + Math.min(40, keywordHits * 6) + Math.min(20, avgChars / 28) + Math.min(15, answeredCount * 3));
  const matching = clamp(25 + Math.min(45, jdHits * 9) + Math.min(30, answeredCount * 5));
  const clarity = clamp(35 + Math.min(35, structureHits * 3.4) + Math.min(20, answeredCount * 4));
  const composure = clamp(60 + answeredCount * 6 + (stats?.hintsUsed ? Math.max(0, 6 - stats.hintsUsed * 2) : 6));

  const overall = Math.round(
    communication * 0.2 + professional * 0.3 + matching * 0.2 + clarity * 0.15 + composure * 0.15
  );
  const strengths = [];
  const improvements = [];
  if (avgChars >= 100) strengths.push("回答有实质内容，能展开关键经历和结论");
  if (structureHits >= 3) strengths.push("使用结构化表达，能看出先框架后细节的倾向");
  if (keywordHits >= 3) strengths.push("主动使用了岗位相关专业词汇");
  if (jdHits >= 2) strengths.push("能把自己的经历与岗位要求对齐");
  if (stats?.pauses && stats.pauses > 0) strengths.push("停顿后仍能继续完成回答，没有放弃表达");
  if (!strengths.length) strengths.push("有开始回答的意愿，已经迈出了最重要的一步");
  if (answeredCount < history.length) improvements.push("仍有题目未完整作答，建议先给一句结论再展开");
  if (avgChars < 80) improvements.push("单题内容偏短，回答可用“结论 + 2 个事实/数据 + 一句复盘”补厚");
  if (keywordHits < 2) improvements.push(`围绕 ${settings.role} 补充专业关键词，例如：${(keywords || []).slice(0, 5).join("、")}`);
  if (structureHits < 3) improvements.push("练习“先说结论，再分点展开，最后收束”的表达结构");
  if (jdHits < 2) improvements.push("回答前先复述岗位要求里的关键词，再映射到自己的项目经历");
  if (!improvements.length) improvements.push("继续保持稳定的练习节奏，下一轮尝试主动补充反问与更深的权衡");

  const perQuestion = history.map((round, index) => {
    const text = round.answer || "";
    const lower = text.toLowerCase();
    const charLen = text.trim().length;
    const hits = keywords.filter((keyword) => lower.includes(keyword)).length;
    const markers = MARKERS.filter((marker) => text.includes(marker)).length;
    const jdHitsForQuestion = jdTokens.filter((token) => token.length > 2 && lower.includes(token)).length;
    const score = text.trim().length < 8
      ? clamp(15 + markers * 3)
      : clamp(35 + Math.min(30, charLen / 14) + hits * 6 + markers * 4 + jdHitsForQuestion * 4);
    const issues = [];
    const plan = [];
    if (charLen < 60) {
      issues.push("回答长度不足，结论与展开信息都比较少");
      plan.push("先给一句直接结论，再补 2-3 个事实点或项目细节");
    } else if (charLen < 140) {
      issues.push("有内容但展开偏薄，缺少更深一层细节");
      plan.push("在关键判断处补上“为什么这么选 / 当时怎么验证 / 结果如何”");
    }
    if (hits < 1) {
      issues.push("未充分使用岗位相关专业表达");
      plan.push(`在回答中主动关联 ${keywords.slice(0, 4).join("、") || "岗位关键词"} 等概念`);
    }
    if (markers < 1 && text) {
      issues.push("结构组织不明显，听感容易散");
      plan.push("采用“结论 → 背景/行动 → 结果 → 复盘”的顺序重讲一遍");
    }
    if (!issues.length) {
      issues.push("整体较完整，可继续增加权衡与量化细节");
      plan.push("下一次在项目回答中加入 1 个数据指标和 1 个失败/权衡点");
    }
    return {
      questionIndex: index,
      question: round.question,
      focus: round.focus || "综合考察",
      answer: text || "本轮未作答",
      score,
      issues: issues.slice(0, 3),
      plan: plan[0] || "按评分建议重新练习",
      strengths: score >= 70 ? ["本题完成度尚可，继续加强深度"] : []
    };
  });

  return {
    overall,
    scores: { communication, professional, matching, clarity, composure },
    summary: `共 ${history.length} 题，有效作答 ${answeredCount} 题，平均回答长度约 ${Math.round(avgChars)} 字。`,
    strengths: strengths.slice(0, 4),
    improvements: improvements.slice(0, 5),
    actionPlan: improvements.slice(0, 3),
    perQuestion,
    source: "local"
  };
}

export function normalizeModelEvaluation(data, fallback) {
  const scores = {};
  DIMENSIONS.forEach((dim) => {
    const value = Number(data?.scores?.[dim.key]);
    scores[dim.key] = Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : fallback.scores[dim.key];
  });
  const overallRaw = Number(data?.overall);
  const overall = Number.isFinite(overallRaw)
    ? Math.max(0, Math.min(100, Math.round(overallRaw)))
    : Math.round(Object.values(scores).reduce((a, b) => a + b, 0) / DIMENSIONS.length);
  return {
    overall,
    scores,
    summary: typeof data?.summary === "string" && data.summary ? data.summary : fallback.summary,
    strengths: Array.isArray(data?.strengths) && data.strengths.length ? data.strengths.map(String) : fallback.strengths,
    improvements: Array.isArray(data?.improvements) && data.improvements.length ? data.improvements.map(String) : fallback.improvements,
    actionPlan:
      Array.isArray(data?.actionPlan) && data.actionPlan.length
        ? data.actionPlan.map(String)
        : fallback.actionPlan || [],
    perQuestion:
      Array.isArray(data?.perQuestion) && data.perQuestion.length
        ? data.perQuestion.map((item, index) => {
            const base = fallback.perQuestion?.[index] || {};
            return {
              questionIndex: index,
              question: base.question || "",
              focus: base.focus || "综合考察",
              answer: base.answer || "",
              score: Number.isFinite(Number(item?.score)) ? clamp(Number(item.score)) : base.score || 0,
              issues: Array.isArray(item?.issues) && item.issues.length ? item.issues.map(String) : base.issues || [],
              plan: typeof item?.plan === "string" && item.plan ? item.plan : base.plan || "请按评分建议重新练习",
              strengths: Array.isArray(item?.strengths) && item.strengths.length ? item.strengths.map(String) : base.strengths || []
            };
          })
        : fallback.perQuestion || [],
    source: "model"
  };
}
