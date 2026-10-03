import { describe, expect, it } from "vitest";
import { localEvaluation } from "../src/lib/evaluate.js";

// 评分评测集：同一岗位、同一份 JD 下的五档典型回答。
// 目的不是"分数好看"，而是保证排序正确——好回答必须比注水回答得分高，
// 而且逐题分与整场分必须自洽，否则访客一眼就能看出评分是编的。
const SETTINGS = {
  role: "前端工程师",
  direction: "互联网",
  jd: "熟悉 React、TypeScript；负责页面开发、性能优化、跨团队协作。"
};

// 注水句：刻意不含结构词、岗位关键词、数字，只把字数堆上去。
const FILLER = "我在以前的工作里参与过一些项目，也遇到过不少麻烦，通常会和同事一起商量，把事情慢慢往前推。";

const EMPTY = "";
const TOO_SHORT = "我有三年经验。";
const WEAK =
  "我做过后台管理系统的页面开发，用的是 React，平时和产品、后端一起对接接口，遇到问题就一起排查。";
const GOOD =
  "我认为这个项目的核心是把首屏加载时间压下来。首先我用 React 和 TypeScript 拆分了组件库，把重复渲染的模块收敛成公共组件；其次把跨页面的状态收敛到单一 store，减少了无效刷新；最后用浏览器缓存和构建分包优化了资源加载，首屏从 3.2 秒降到 1.8 秒，提升了 44%。项目上线后 DAU 涨了 12%。";

function evaluate(answers, stats = { pauses: 4, hintsUsed: 0 }) {
  return localEvaluation({
    settings: SETTINGS,
    history: answers.map((answer, index) => ({ question: `Q${index + 1}`, answer, focus: "综合考察" })),
    stats
  });
}

describe("localEvaluation 评测集", () => {
  it("按回答质量单调排序：无效作答 < 注水 < 一般 < 优质", () => {
    const empty = evaluate([EMPTY]);
    const tooShort = evaluate([TOO_SHORT]);
    const padding = evaluate([FILLER.repeat(12)]);
    const weak = evaluate([WEAK]);
    const good = evaluate([GOOD]);

    expect(empty.overall).toBe(0);
    expect(tooShort.overall).toBe(0);
    expect(padding.overall).toBeLessThan(weak.overall);
    expect(weak.overall).toBeLessThan(good.overall);
    expect(good.overall).toBeGreaterThanOrEqual(70);
  });

  it("未作答不给参与分，逐题分为 0 且写明未作答", () => {
    const out = evaluate([EMPTY, TOO_SHORT]);
    expect(out.perQuestion.map((item) => item.score)).toEqual([0, 0]);
    expect(out.perQuestion.every((item) => item.answer === "本轮未作答")).toBe(true);
    expect(out.scores.composure).toBe(0);
    expect(out.summary).toContain("有效作答 0 题");
  });

  it("把话说长不再持续加分：350 字与 500 字的同类注水回答分差很小", () => {
    const short = evaluate([FILLER.repeat(8)]);
    const long = evaluate([FILLER.repeat(12)]);
    expect(Math.abs(long.overall - short.overall)).toBeLessThanOrEqual(3);
    expect(long.overall).toBeLessThan(evaluate([GOOD]).overall);
  });

  it("逐题分与整场分自洽：同等优质的三题，单题分与总分一致", () => {
    const out = evaluate([GOOD, GOOD, GOOD]);
    const perQuestionScores = out.perQuestion.map((item) => item.score);
    expect(new Set(perQuestionScores).size).toBe(1);
    expect(Math.abs(out.overall - perQuestionScores[0])).toBeLessThanOrEqual(2);
  });

  it("漏答会通过完成率拉低总分，但不会污染已作答那题的分数", () => {
    const full = evaluate([GOOD, GOOD]);
    const partial = evaluate([GOOD, EMPTY]);
    expect(partial.overall).toBeLessThan(full.overall);
    expect(partial.perQuestion[0].score).toBe(full.perQuestion[0].score);
    expect(partial.perQuestion[1].score).toBe(0);
    expect(partial.scores.composure).toBeLessThan(full.scores.composure);
  });

  it("维度分落在 0-100，且每题的改进建议都指向具体动作", () => {
    const out = evaluate([GOOD, WEAK, EMPTY]);
    Object.values(out.scores).forEach((score) => {
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    });
    out.perQuestion.forEach((item) => {
      expect(item.issues.length).toBeGreaterThan(0);
      expect(typeof item.plan).toBe("string");
      expect(item.plan.length).toBeGreaterThan(0);
    });
    expect(out.improvements.length).toBeGreaterThan(0);
    expect(out.actionPlan.length).toBeGreaterThan(0);
  });
});
