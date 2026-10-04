import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DATA_FLOW, dataFlowCompact, dataFlowFull, dataFlowShort } from "../src/lib/privacy.js";

// jsdom 环境下 import.meta.url 不是真实磁盘路径，这里以仓库根目录（vitest 的 cwd）为准。
const read = (relative) => readFileSync(path.join(process.cwd(), relative), "utf8");

// 公开部署（魔搭创空间）时，"哪些内容会离开浏览器"必须说全。
// 曾经每个页面各写一句"数据仅保存在当前浏览器"，只讲了本机这一半。
describe("数据流向告知", () => {
  it("长文案同时覆盖本机留存、模型传输与录音上传", () => {
    expect(dataFlowFull).toContain("浏览器");
    // 有了账号体系后，简历不再"只在本机"：必须把服务端这一环说清楚
    expect(dataFlowFull).toContain("服务器");
    expect(dataFlowFull).toContain("账号");
    expect(dataFlowFull).toContain("模型服务");
    expect(dataFlowFull).toContain("录音");
  });

  it("缩略版也必须提到模型传输，不能只讲本机", () => {
    expect(dataFlowCompact).toContain("本机");
    expect(dataFlowCompact).toContain("模型服务");
  });

  it("拼接顺序稳定：本机 → 账号 → 模型 → 语音", () => {
    expect(dataFlowShort).toBe(DATA_FLOW.local + DATA_FLOW.account + DATA_FLOW.model);
    expect(dataFlowFull).toBe(dataFlowShort + DATA_FLOW.voice);
  });

  it("账号那段写清了密码只存哈希，并给出导出与注销出口", () => {
    expect(DATA_FLOW.account).toContain("哈希");
    expect(DATA_FLOW.account).toContain("导出");
    expect(DATA_FLOW.account).toContain("注销");
  });

  it("四个页面都不再出现只说本机的旧说法", () => {
    const files = [
      "src/App.jsx",
      "src/components/LoginView.jsx",
      "src/components/WorkbenchPage.jsx",
      "src/components/ReportView.jsx"
    ];
    for (const file of files) {
      expect(read(file), file).not.toContain("数据仅保存在当前浏览器");
    }
  });

  it("报告带免责说明，避免把练习评分当成真实结论", () => {
    const report = read("src/components/ReportView.jsx");
    expect(report).toContain("report-disclaimer");
    expect(report).toContain("不代表真实面试结论");
  });
});
