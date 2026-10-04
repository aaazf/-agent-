import { describe, expect, it } from "vitest";
import { evaluateAuthBoundary, evaluateHealth, evaluatePage, summarize } from "../scripts/preflight.mjs";

const HEALTHY = {
  ok: true,
  tts: { available: true, reason: "" },
  asr: { available: true, model: "FunAudioLLM/SenseVoiceSmall", reason: "" },
  hostedLlm: {
    enabled: true,
    model: "Qwen/Qwen3.5-35B-A3B",
    perIpPerDay: 40,
    modelAvailable: true,
    dailyBudget: { day: "2026-10-04", used: 12, max: 800 }
  },
  accounts: {
    signup: true,
    inviteRequired: true,
    sessionTtlDays: 30,
    persistent: true,
    users: 3,
    resumes: 5,
    reason: ""
  },
  limits: { maxBodyBytes: 12582912, llmPerMinute: 20, asrPerMinute: 20, asrPerDay: 600 }
};

const BUILT_PAGE = '<div id="root"></div><script type="module" src="/assets/index-x.js"></script>';

describe("部署自检", () => {
  it("全绿时既没有必须处理的项，也没有告警", () => {
    const checks = [...evaluateHealth(HEALTHY), ...evaluatePage(BUILT_PAGE, 200)];
    const { failed, warnings, ok } = summarize(checks);
    expect(ok).toBe(true);
    expect(failed).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  it("托管模型不在上游清单里判为必须处理，并给出在架候选", () => {
    const checks = evaluateHealth({
      ...HEALTHY,
      hostedLlm: {
        ...HEALTHY.hostedLlm,
        modelAvailable: false,
        availableModels: ["Qwen/Qwen3.5-35B-A3B", "ZhipuAI/GLM-4.7-Flash"]
      }
    });
    const { ok, failed } = summarize(checks);
    expect(ok).toBe(false);
    expect(failed.map((item) => item.name)).toContain("托管模型");
    expect(failed.find((item) => item.name === "托管模型").detail).toContain("ZhipuAI/GLM-4.7-Flash");
  });

  it("没配共享额度只算 WARN，不阻断部署", () => {
    const checks = evaluateHealth({ ...HEALTHY, hostedLlm: { enabled: false, model: "", perIpPerDay: 0 } });
    const { ok, failed, warnings } = summarize(checks);
    expect(ok).toBe(true);
    expect(failed).toHaveLength(0);
    expect(warnings.map((item) => item.name)).toContain("共享额度");
  });

  it("语音能力缺失只降级为 WARN，文字面试仍可用", () => {
    const checks = evaluateHealth({
      ...HEALTHY,
      tts: { available: false, reason: "缺少 python3" },
      asr: { available: false, model: "", reason: "缺少配置：ASR_MODEL" }
    });
    const { ok, warnings } = summarize(checks);
    expect(ok).toBe(true);
    expect(warnings.map((item) => item.name)).toEqual(["语音播报", "语音识别"]);
  });

  it("当日额度接近上限时给出 WARN，但不阻断部署", () => {
    const checks = evaluateHealth({
      ...HEALTHY,
      hostedLlm: { ...HEALTHY.hostedLlm, dailyBudget: { day: "2026-10-04", used: 790, max: 800 } }
    });
    const { ok, warnings } = summarize(checks);
    expect(ok).toBe(true);
    expect(warnings.map((item) => item.name)).toEqual(["当日额度余量"]);
  });

  it("额度还算充裕时不产生任何告警", () => {
    const { warnings } = summarize(evaluateHealth(HEALTHY));
    expect(warnings).toHaveLength(0);
  });

  it("首页不是构建产物时判为必须处理", () => {
    const { ok, failed } = summarize(evaluatePage("<html><body>blank</body></html>", 200));
    expect(ok).toBe(false);
    expect(failed.map((item) => item.name)).toEqual(["页面挂载点", "前端产物"]);
  });

  it("服务端没起来时只报接口不可达，不抛异常", () => {
    const checks = evaluateHealth(null);
    expect(checks).toHaveLength(1);
    expect(checks[0].required).toBe(true);
    expect(summarize(checks).ok).toBe(false);
  });

  it("没有 accounts 字段的旧镜像判为必须处理（登录页会一直失败）", () => {
    const { accounts, ...legacy } = HEALTHY;
    expect(accounts).toBeDefined();
    const { ok, failed } = summarize(evaluateHealth(legacy));
    expect(ok).toBe(false);
    expect(failed.map((item) => item.name)).toContain("账号体系");
  });

  it("数据目录不可写时给出 WARN，并说明重启后会丢账号", () => {
    const checks = evaluateHealth({
      ...HEALTHY,
      accounts: { ...HEALTHY.accounts, persistent: false, reason: "EACCES: permission denied" }
    });
    const { ok, warnings } = summarize(checks);
    expect(ok).toBe(true);
    const item = warnings.find((check) => check.name === "数据持久化");
    expect(item.detail).toContain("丢失");
    expect(item.detail).toContain("EACCES");
  });

  it("公开注册且没有邀请码时提醒设置 SIGNUP_INVITE_CODE", () => {
    const checks = evaluateHealth({ ...HEALTHY, accounts: { ...HEALTHY.accounts, inviteRequired: false } });
    expect(summarize(checks).warnings.map((item) => item.name)).toContain("注册防线");
  });

  it("认证边界：未登录必须 401，返回 200 就是越权", () => {
    expect(summarize(evaluateAuthBoundary({ me: 401, resumes: 401 })).ok).toBe(true);
    const leaked = summarize(evaluateAuthBoundary({ me: 401, resumes: 200 }));
    expect(leaked.ok).toBe(false);
    expect(leaked.failed.map((item) => item.name)).toEqual(["认证边界 · 简历读取"]);
  });
});
