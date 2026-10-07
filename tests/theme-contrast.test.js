import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (relative) => readFileSync(path.join(process.cwd(), relative), "utf8");

// 「曜石黑」主题是一组覆盖规则，靠"把浅色面板改成深色"实现。
// 新增页面时如果忘了把面板写进这份清单，就会得到白底浅色字——实测对比度 1.1，
// 题面几乎看不见。这里把面试页用到的面板钉住，避免再漏。
describe("深色主题必须覆盖面试页的面板", () => {
  const css = read("src/styles.css");
  const interviewPanels = [
    "stage-card",
    "question-card",
    "interview-status",
    "buffer-rail",
    "voice-ready-panel",
    "camera-placeholder",
    "resume-panel"
  ];

  it("面试页的每个浅底面板都有对应的深色覆盖", () => {
    for (const cls of interviewPanels) {
      expect(css, cls).toContain(`.guide-shell.theme-black .${cls}`);
    }
  });

  it("深色主题下这些面板用的是深底，不是原来的浅底", () => {
    const block = css.slice(css.indexOf(".guide-shell.theme-black .stage-card"));
    const slice = block.slice(0, block.indexOf("}"));
    expect(slice).toContain("background: #0b0f12 !important");
    expect(slice).toContain("border-color: #273139 !important");
  });

  it("深色主题下写在浅底上的深色小字也要跟着变亮", () => {
    // #31505b / #3e4e5b 这类硬编码深色在深色底上读不出来
    expect(css).toContain(".guide-shell.theme-black .qa-strip > span:first-child");
    expect(css).toContain(".guide-shell.theme-black .answer-area label > span");
    expect(css).toContain(".guide-shell.theme-black .stage-title");
    expect(css).toContain(".onboarding-shell .stage-title");
  });

  it("首次引导的外壳（.onboarding-shell）也要覆盖，面试页就在它下面", () => {
    for (const cls of interviewPanels) {
      expect(css, cls).toContain(`.onboarding-shell .${cls}`);
    }
  });

  it("浅色主题不受影响：基础规则仍然保留浅色底", () => {
    expect(css).toMatch(/\.stage-card \{[^}]*background: #fff/s);
    expect(css).toMatch(/\.question-card \{[^}]*background: #f8fbfb/s);
  });
});
