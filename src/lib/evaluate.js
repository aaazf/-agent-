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

// 低于这个长度视为没有有效作答：直接 0 分，不再给"参与分"把均分抬上去。
const ANSWER_MIN_CHARS = 8;
export const NO_ANSWER_TEXT = "本轮未作答";

// 打分表刻意"奖励有效信息、不奖励字数"：
// 结论、数据、岗位关联、结构清晰的回答拿高分；单纯把话说长不再持续加分。
const DEPTH_BY_HITS = [8, 42, 62, 75, 84, 90];
const STRUCTURE_BY_MARKERS = [22, 46, 66, 80, 90];
const MATCH_BY_JD_HITS = [30, 56, 72, 85, 92];
// 逐题分与整场分共用同一套权重，报告不会出现"每题 80 多、总分只有 60"的自相矛盾。
const DIMENSION_WEIGHTS = {
  communication: 0.2,
  professional: 0.3,
  matching: 0.2,
  clarity: 0.15,
  composure: 0.15
};

// 内容量：40 字以内快速爬升，140 字左右接近满分，超过 320 字不再加分。
function contentScore(charLen) {
  if (charLen < ANSWER_MIN_CHARS) return 0;
  if (charLen < 40) return 25 + ((charLen - ANSWER_MIN_CHARS) / 32) * 30;
  if (charLen < 140) return 55 + ((charLen - 40) / 100) * 30;
  if (charLen < 320) return 85 + ((charLen - 140) / 180) * 10;
  return 95;
}

function weighted(dimensions) {
  return Object.keys(DIMENSION_WEIGHTS).reduce((sum, key) => sum + dimensions[key] * DIMENSION_WEIGHTS[key], 0);
}

// 单题评分：五个维度各自打分，逐题分就是这五个维度按同一权重的加权和。
function scoreAnswer(text, keywords, jdTokens) {
  const trimmed = (text || "").trim();
  const charLen = trimmed.length;
  const lower = trimmed.toLowerCase();
  const answered = charLen >= ANSWER_MIN_CHARS;
  const hits = answered ? keywords.filter((keyword) => lower.includes(keyword)).length : 0;
  const markers = answered ? MARKERS.filter((marker) => trimmed.includes(marker)).length : 0;
  const jdHits = answered ? jdTokens.filter((token) => token.length > 2 && lower.includes(token)).length : 0;
  // 带数字说明在讲事实而不是感受，这是面试里最有效的加分项之一。
  const quantified = answered && /\d/.test(trimmed);
  // 结论先行：中文回答里"我认为 / 结论是"这类引导词。
  const hasConclusion = answered && /(我认为|我的判断|结论是|简单说|一句话|核心是)/.test(trimmed);
  const content = contentScore(charLen);
  const structure = Math.min(
    100,
    STRUCTURE_BY_MARKERS[Math.min(markers, 4)] + (quantified ? 8 : 0) + (hasConclusion ? 6 : 0)
  );
  // 信息密度：讲得多 ≠ 讲得有用。把"岗位关键词 + JD 命中 + 数字"折算成 0-1，
  // 注水式的长回答会在这一项失分，而不是靠字数把"沟通表达"刷上去。
  const density = Math.min(1, (hits + jdHits + (quantified ? 1 : 0)) / 3);

  const dimensions = {
    communication: answered
      ? Math.min(100, content * 0.45 + structure * 0.25 + density * 25 + (hasConclusion ? 8 : 0))
      : 0,
    professional: answered
      ? Math.min(100, DEPTH_BY_HITS[Math.min(hits, 5)] * (0.62 + content / 250) * (0.75 + density * 0.25))
      : 0,
    matching: answered ? MATCH_BY_JD_HITS[Math.min(jdHits, 4)] : 0,
    clarity: answered ? structure : 0,
    // 临场稳定最终由整场信号决定（完成率/停顿/提示），单题先给"是否完整讲完"的近似值。
    composure: answered ? Math.min(100, 68 + (markers > 0 ? 12 : 0) + (quantified ? 8 : 0)) : 0
  };

  return {
    answered,
    charLen,
    hits,
    markers,
    jdHits,
    quantified,
    hasConclusion,
    dimensions,
    score: clamp(weighted(dimensions))
  };
}

export function localEvaluation({ settings, history, stats }) {
  const keywords = ROLE_KEYWORDS[settings.role] || [];
  const jdTokens = [...new Set((settings.jd || "").toLowerCase().match(/[a-z][a-z0-9+/.-]{1,}/g) || [])];
  const rounds = history.map((round) => ({ round, ...scoreAnswer(round.answer, keywords, jdTokens) }));
  const answeredRounds = rounds.filter((item) => item.answered);
  const answeredCount = answeredRounds.length;
  const totalChars = answeredRounds.reduce((sum, item) => sum + item.charLen, 0);
  const avgChars = answeredCount ? totalChars / answeredCount : 0;
  const completion = history.length ? answeredCount / history.length : 0;
  const structureHits = answeredRounds.reduce((sum, item) => sum + item.markers, 0);
  const keywordHits = answeredRounds.reduce((sum, item) => sum + item.hits, 0);
  const jdHits = answeredRounds.reduce((sum, item) => sum + item.jdHits, 0);
  const quantifiedCount = answeredRounds.filter((item) => item.quantified).length;

  // 整场维度分 = 有效作答在该维度上的平均分；未作答不计入平均，只通过完成率影响临场分。
  const dimensionAverage = (key) =>
    answeredCount ? answeredRounds.reduce((sum, item) => sum + item.dimensions[key], 0) / answeredCount : 0;
  const communication = clamp(dimensionAverage("communication"));
  const professional = clamp(dimensionAverage("professional"));
  const matching = clamp(dimensionAverage("matching"));
  const clarity = clamp(dimensionAverage("clarity"));
  const composure =
    answeredCount === 0
      ? 0
      : clamp(
          40 +
            completion * 40 +
            Math.min(8, (stats?.pauses || 0) * 2) -
            (stats?.hintsUsed ? Math.min(15, stats.hintsUsed * 5) : 0)
        );

  const scores = { communication, professional, matching, clarity, composure };
  const overall = clamp(weighted(scores));
  const strengths = [];
  const improvements = [];
  if (avgChars >= 100) strengths.push("回答有实质内容，能展开关键经历和结论");
  if (structureHits >= 3) strengths.push("使用结构化表达，能看出先框架后细节的倾向");
  if (keywordHits >= 3) strengths.push("主动使用了岗位相关专业词汇");
  if (jdHits >= 2) strengths.push("能把自己的经历与岗位要求对齐");
  if (answeredCount > 0 && quantifiedCount >= Math.max(1, Math.ceil(answeredCount * 0.5))) {
    strengths.push("回答里带了具体数字或指标，比只谈感受更有说服力");
  }
  if (stats?.pauses && stats.pauses > 0) strengths.push("停顿后仍能继续完成回答，没有放弃表达");
  if (!strengths.length) strengths.push("有开始回答的意愿，已经迈出了最重要的一步");
  if (answeredCount === 0) improvements.push("本场没有留下有效回答，先从一个具体项目讲起会更容易进入状态");
  else if (answeredCount < history.length) improvements.push("仍有题目未完整作答，建议先给一句结论再展开");
  if (answeredCount > 0 && quantifiedCount < Math.ceil(answeredCount * 0.5)) {
    improvements.push("多数回答只有定性描述，补一个数字（提升多少、影响多少人、耗时缩短多少）会更有力");
  }
  if (avgChars < 80) improvements.push("单题内容偏短，回答可用“结论 + 2 个事实/数据 + 一句复盘”补厚");
  if (avgChars >= 320) improvements.push("单题偏长，重点容易被淹没；压到 150-250 字并先给结论，听感会更好");
  if (keywordHits < 2) improvements.push(`围绕 ${settings.role} 补充专业关键词，例如：${(keywords || []).slice(0, 5).join("、")}`);
  if (structureHits < 3) improvements.push("练习“先说结论，再分点展开，最后收束”的表达结构");
  if (jdHits < 2) improvements.push("回答前先复述岗位要求里的关键词，再映射到自己的项目经历");
  if (!improvements.length) improvements.push("继续保持稳定的练习节奏，下一轮尝试主动补充反问与更深的权衡");

  const perQuestion = history.map((round, index) => {
    const item = rounds[index];
    const { charLen, hits, markers, quantified, answered } = item;
    const issues = [];
    const plan = [];
    if (!answered) {
      issues.push("这一题没有有效作答，无法评估深度");
      plan.push("先给一句话结论，再补一个具体例子；答得短也比空着强");
    } else {
      if (charLen < 60) {
        issues.push("回答长度不足，结论与展开信息都比较少");
        plan.push("先给一句直接结论，再补 2-3 个事实点或项目细节");
      } else if (charLen >= 320) {
        issues.push("内容过长，重点被淹没，面试官需要自己提炼");
        plan.push("压到 150-250 字：结论 → 一个例子 → 一句结果");
      } else if (charLen < 140) {
        issues.push("有内容但展开偏薄，缺少更深一层细节");
        plan.push("在关键判断处补上“为什么这么选 / 当时怎么验证 / 结果如何”");
      }
      if (!quantified) {
        issues.push("缺少可验证的数据或指标，说服力偏弱");
        plan.push("补一个数字：提升多少、影响多少人、耗时缩短多少");
      }
      if (hits < 1) {
        issues.push("未充分使用岗位相关专业表达");
        plan.push(`在回答中主动关联 ${keywords.slice(0, 4).join("、") || "岗位关键词"} 等概念`);
      }
      if (markers < 1) {
        issues.push("结构组织不明显，听感容易散");
        plan.push("采用“结论 → 背景/行动 → 结果 → 复盘”的顺序重讲一遍");
      }
      if (item.jdHits < 1) {
        issues.push("没有回应岗位要求里的关注点");
        plan.push("回答前先复述岗位 JD 的一个要求，再映射到自己的经历");
      }
    }
    if (!issues.length) {
      issues.push("整体较完整，可继续增加权衡与失败复盘");
      plan.push("下一次在项目回答里补 1 个失败/权衡点和它的复盘");
    }
    return {
      questionIndex: index,
      question: round.question,
      focus: round.focus || "综合考察",
      answer: answered ? round.answer : NO_ANSWER_TEXT,
      score: item.score,
      issues: issues.slice(0, 3),
      plan: plan[0] || "按评分建议重新练习",
      strengths: answered ? [`本题五维加权 ${item.score} 分，${item.score >= 75 ? "完成度较高" : "基本答到了点上"}`] : []
    };
  });

  return {
    overall,
    scores,
    summary: `共 ${history.length} 题，有效作答 ${answeredCount} 题（完成率 ${Math.round(completion * 100)}%），平均回答长度约 ${Math.round(avgChars)} 字。`,
    strengths: strengths.slice(0, 4),
    improvements: improvements.slice(0, 5),
    actionPlan: improvements.slice(0, 3),
    perQuestion,
    source: "local"
  };
}

export function normalizeModelEvaluation(data, fallback) {
  // 以本地逐题结果为准合并模型结果：模型少返回某题时保留本地反馈，避免整题丢失。
  const mergePerQuestion = (modelList, fallbackList) => {
    const baseList = Array.isArray(fallbackList) ? fallbackList : [];
    const source = Array.isArray(modelList) ? modelList : [];
    const length = Math.max(baseList.length, source.length);
    return Array.from({ length }, (_, index) => {
      const base = baseList[index] || {};
      const item = source[index] || {};
      return {
        questionIndex: index,
        question: base.question || "",
        focus: base.focus || "综合考察",
        answer: base.answer || "",
        score: Number.isFinite(Number(item?.score)) ? clamp(Number(item.score)) : base.score || 0,
        issues: Array.isArray(item?.issues) && item.issues.length ? item.issues.map(String) : base.issues || [],
        plan: typeof item?.plan === "string" && item.plan ? item.plan : base.plan || "请按评分建议重新练习",
        strengths:
          Array.isArray(item?.strengths) && item.strengths.length ? item.strengths.map(String) : base.strengths || []
      };
    });
  };
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
    perQuestion: mergePerQuestion(data?.perQuestion, fallback.perQuestion),
    source: "model"
  };
}
