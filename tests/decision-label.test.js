import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DECISION_LABELS, decisionLabel, normalizeInterviewerDecision } from "../src/lib/model.js";

const read = (relative) => readFileSync(path.join(process.cwd(), relative), "utf8");

// 上线前的真实界面问题：面试页顶部的徽标直接显示成
// 「gpt-4o-mini 理解回答后决策：followup」——内部英文 token 漏到了用户面前，
// 而且模型名取的是设置页里的名字，用共享额度时与实际生效的模型对不上。
describe("面试官决策：内部 token 不能漏到界面上", () => {
  it("四种决策都映射成中文说法", () => {
    expect(decisionLabel("followup")).toBe("针对回答追问");
    expect(decisionLabel("new_dimension")).toBe("切换新维度");
    expect(decisionLabel("probe")).toBe("深挖验证");
    expect(decisionLabel("wrap")).toBe("收束话题");
  });

  it("未知类型退回通用说法，不会把 undefined 显示给用户", () => {
    expect(decisionLabel(undefined)).toBe("模型动态出题");
    expect(decisionLabel("whatever")).toBe("模型动态出题");
    expect(decisionLabel(undefined)).not.toContain("undefined");
  });

  it("中文说法里不含内部 token", () => {
    for (const [token, label] of Object.entries(DECISION_LABELS)) {
      expect(label, token).not.toContain(token);
    }
  });

  it("面试页用 decisionLabel 渲染，且不再出现旧的英文拼句", () => {
    const view = read("src/components/InterviewView.jsx");
    expect(view).toContain("decisionLabel(decision.type)");
    expect(view).not.toContain("理解回答后决策");
  });

  it("徽标写实际生效的模型，而不是设置页里的模型名", () => {
    const view = read("src/components/InterviewView.jsx");
    expect(view).toContain("displayModelName({ settings, hosted: hostedRef.current })");
  });

  it("规范化后的决策类型一定在这四种之内", () => {
    const ok = normalizeInterviewerDecision({ reply: "好的", question: "请介绍一个项目", decision: "probe" });
    expect(decisionLabel(ok.type)).toBe("深挖验证");
    const fallback = normalizeInterviewerDecision({ question: "请介绍一个项目", decision: "nonsense" });
    expect(Object.keys(DECISION_LABELS)).toContain(fallback.type);
  });
});