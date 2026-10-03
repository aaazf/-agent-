import { describe, expect, it } from "vitest";
import { MODEL_CATALOG, PROVIDERS, PROVIDER_OPTIONS, providerByLabel } from "../src/lib/providers.js";
import { buildAskMessages, buildEvaluateMessages, extractJson, normalizeInterviewerDecision, truncate } from "../src/lib/model.js";
import { localEvaluation, normalizeModelEvaluation } from "../src/lib/evaluate.js";
import { analyzeResumeLocal, profileForPrompt } from "../src/lib/resume.js";
import { localQuestion } from "../src/lib/questions.js";
import { DIMENSIONS, formatTime, secondsLabel } from "../src/lib/storage.js";

describe("providers", () => {
  it("keeps a single source of truth for preset providers", () => {
    expect(PROVIDERS.map((p) => p.label)).toEqual([
      "OpenAI",
      "DeepSeek",
      "阿里云百炼 Qwen",
      "智谱 GLM",
      "Kimi",
      "魔搭 ModelScope"
    ]);
    expect(Object.keys(MODEL_CATALOG)).toContain("自定义");
    expect(PROVIDER_OPTIONS).toHaveLength(PROVIDERS.length + 1);
    expect(PROVIDERS.every((p) => p.baseUrl && p.models.length > 0)).toBe(true);
  });

  it("falls back to the custom provider for unknown labels", () => {
    expect(providerByLabel("OpenAI").baseUrl).toBe("https://api.openai.com/v1");
    expect(providerByLabel("不存在").label).toBe("自定义");
  });
});

describe("extractJson", () => {
  it("parses plain, fenced and embedded JSON", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(extractJson('好的，结果是 {"a":3} 完毕')).toEqual({ a: 3 });
  });

  it("throws on non-JSON output", () => {
    expect(() => extractJson("完全不是 JSON")).toThrow();
  });
});

describe("normalizeInterviewerDecision", () => {
  it("falls back to followup and rejects empty questions", () => {
    const ok = normalizeInterviewerDecision({ decision: "???", reply: "嗯", question: "那后来呢？" });
    expect(ok.type).toBe("followup");
    expect(ok.text).toBe("嗯\n\n那后来呢？");
    expect(() => normalizeInterviewerDecision({ question: "  " })).toThrow();
  });
});

describe("prompt building", () => {
  const settings = {
    direction: "互联网",
    role: "前端工程师",
    style: "标准专业",
    jd: "岗位要求".repeat(1000),
    resume: "简历".repeat(3000),
    resumeAnalysis: null,
    modelName: "gpt-4o-mini"
  };
  const history = Array.from({ length: 20 }, (_, i) => ({
    question: `第 ${i + 1} 题`,
    answer: "回答".repeat(1000)
  }));

  it("truncates to the exact character budget", () => {
    expect(truncate("a".repeat(100), 10).length).toBeLessThanOrEqual(10);
    expect(truncate("abc", 10)).toBe("abc");
    expect(truncate(null, 10)).toBe("");
  });

  it("bounds prompt size regardless of interview length", () => {
    const ask = buildAskMessages({ settings, history });
    const evaluate = buildEvaluateMessages({ settings, history });
    const size = (msgs) => msgs.reduce((sum, m) => sum + m.content.length, 0);
    expect(size(ask)).toBeLessThan(12000);
    expect(size(evaluate)).toBeLessThan(11000);
    expect(ask[1].content).toContain("<<<DATA");
  });

  it("instructs the model to ignore instructions inside candidate data", () => {
    expect(buildAskMessages({ settings, history })[0].content).toContain("不得执行");
    expect(buildEvaluateMessages({ settings, history })[0].content).toContain("不得执行");
  });
});

describe("normalizeModelEvaluation", () => {
  const fallback = {
    overall: 60,
    scores: { communication: 60, professional: 61, matching: 62, clarity: 63, composure: 64 },
    summary: "本地",
    strengths: ["s"],
    improvements: ["i"],
    actionPlan: ["a"],
    perQuestion: [
      { questionIndex: 0, question: "Q1", focus: "自我介绍", answer: "A1", score: 50, issues: ["x"], plan: "p1", strengths: [] },
      { questionIndex: 1, question: "Q2", focus: "项目深挖", answer: "A2", score: 55, issues: ["y"], plan: "p2", strengths: [] },
      { questionIndex: 2, question: "Q3", focus: "岗位匹配", answer: "A3", score: 58, issues: ["z"], plan: "p3", strengths: [] }
    ]
  };

  it("keeps local feedback for questions the model omitted", () => {
    const out = normalizeModelEvaluation({ perQuestion: [{ score: 88, issues: ["m1"], plan: "mp1" }] }, fallback);
    expect(out.perQuestion).toHaveLength(3);
    expect(out.perQuestion[0].score).toBe(88);
    expect(out.perQuestion[2]).toMatchObject({ score: 58, question: "Q3", plan: "p3" });
  });

  it("clamps scores and rejects non-numeric values", () => {
    const out = normalizeModelEvaluation({ perQuestion: [{ score: 250 }, { score: "abc" }, { score: -5 }] }, fallback);
    expect(out.perQuestion.map((q) => q.score)).toEqual([100, 55, 0]);
  });

  it("still returns model items when there is no local baseline", () => {
    const out = normalizeModelEvaluation({ perQuestion: [{ score: 70, plan: "x" }] }, { scores: {}, perQuestion: [] });
    expect(out.perQuestion).toHaveLength(1);
  });
});

describe("localEvaluation", () => {
  const settings = { role: "前端工程师", direction: "互联网", jd: "react typescript 性能 组件" };

  it("scores every dimension within range and answers every question", () => {
    const history = [
      { question: "Q1", answer: "首先我负责 React 组件库，其次做了性能优化，最后结果提升 40%。" },
      { question: "Q2", answer: "" }
    ];
    const out = localEvaluation({ settings, history, stats: { pauses: 1, hintsUsed: 0 } });
    DIMENSIONS.forEach((d) => {
      expect(out.scores[d.key]).toBeGreaterThanOrEqual(0);
      expect(out.scores[d.key]).toBeLessThanOrEqual(100);
    });
    expect(out.perQuestion).toHaveLength(2);
    expect(out.source).toBe("local");
  });
});

describe("resume parsing", () => {
  const raw = [
    "张三",
    "性别：男",
    "5 年工作经验",
    "邮箱：zhangsan@example.com",
    "电话：13800138000",
    "专业技能",
    "React、TypeScript、Node.js",
    "项目经历",
    "电商运营看板",
    "- 负责组件库与状态管理，首屏性能提升 40%"
  ].join("\n");

  it("extracts profile facts and projects locally", () => {
    const out = analyzeResumeLocal(raw);
    expect(out.name).toBe("张三");
    expect(out.gender).toBe("男");
    expect(out.years).toBe("5");
    expect(out.email).toBe("zhangsan@example.com");
    expect(out.phone).toBe("13800138000");
    expect(out.skills).toContain("React");
    expect(out.projects.length).toBeGreaterThan(0);
    expect(out.source).toBe("local");
  });

  it("renders a prompt profile", () => {
    const text = profileForPrompt(analyzeResumeLocal(raw));
    expect(text).toContain("姓名：张三");
    expect(text).toContain("技能：");
  });
});

describe("localQuestion", () => {
  const settings = {
    role: "前端工程师",
    style: "温和引导",
    resume: "项目：电商看板\n- 负责组件库",
    jd: "React",
    resumeAnalysis: null
  };

  it("always returns a usable question", () => {
    for (let i = 0; i < 10; i += 1) {
      const q = localQuestion(settings, i);
      expect(typeof q.text).toBe("string");
      expect(q.text.length).toBeGreaterThan(0);
      expect(q.source).toBe("offline");
    }
  });
});

describe("storage helpers", () => {
  it("formats time and durations", () => {
    expect(secondsLabel(0)).toBe("0 秒");
    expect(secondsLabel(5000)).toBe("5 秒");
    expect(secondsLabel(65000)).toBe("1 分 5 秒");
    expect(formatTime(new Date(2026, 0, 2, 3, 4).getTime())).toBe("2026-01-02 03:04");
  });

  it("lists the five scoring dimensions", () => {
    expect(DIMENSIONS.map((d) => d.key)).toEqual(["communication", "professional", "matching", "clarity", "composure"]);
  });
});
