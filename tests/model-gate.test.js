import { afterEach, describe, expect, it, vi } from "vitest";
import { displayModelName, modelAvailable } from "../src/hooks/useHostedQuota.js";

const healthWithQuota = async () => ({
  ok: true,
  json: async () => ({ ok: true, hostedLlm: { enabled: true, model: "Qwen/Qwen3.5-35B-A3B", perIpPerDay: 40 } })
});
const healthWithoutQuota = async () => ({ ok: true, json: async () => ({ ok: true, hostedLlm: { enabled: false } }) });

// canUseModel 内部会读 /api/health（会话内缓存），所以每个用例都重新加载模块。
async function loadCanUseModel(fetchImpl) {
  vi.stubGlobal("fetch", fetchImpl);
  vi.resetModules();
  const mod = await import("../src/lib/model.js");
  return mod.canUseModel;
}

describe("canUseModel：能不能用模型的唯一判断入口", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("自带 Key 且开启模型时可用", async () => {
    const canUseModel = await loadCanUseModel(vi.fn());
    await expect(canUseModel({ apiKey: "sk-x", modelEnabled: true })).resolves.toBe(true);
  });

  it("没有 Key 但有本站共享额度时同样可用（回归：这曾经被判成不可用）", async () => {
    const canUseModel = await loadCanUseModel(vi.fn(healthWithQuota));
    await expect(canUseModel({ apiKey: "", modelEnabled: true })).resolves.toBe(true);
  });

  it("没有 Key 也没有共享额度时不可用，且不会白白发请求", async () => {
    const fetchMock = vi.fn(healthWithoutQuota);
    const canUseModel = await loadCanUseModel(fetchMock);
    await expect(canUseModel({ apiKey: "   ", modelEnabled: true })).resolves.toBe(false);
    // 只探测了一次 /api/health，没有去调 /api/llm
    expect(fetchMock.mock.calls.every(([url]) => String(url).includes("/api/health"))).toBe(true);
  });

  it("访客显式关掉模型时，即便有共享额度也不可用", async () => {
    const canUseModel = await loadCanUseModel(vi.fn(healthWithQuota));
    await expect(canUseModel({ apiKey: "sk-x", modelEnabled: false })).resolves.toBe(false);
  });
});

describe("渲染期判断：共享额度也要显示成已接入", () => {
  it("没 Key 但有共享额度算已接入", () => {
    expect(modelAvailable({ settings: { modelEnabled: true, apiKey: "" }, hosted: { model: "Qwen" } })).toBe(true);
  });

  it("没 Key 也没共享额度不算已接入", () => {
    expect(modelAvailable({ settings: { modelEnabled: true, apiKey: "" }, hosted: false })).toBe(false);
    expect(modelAvailable({ settings: { modelEnabled: true, apiKey: "" }, hosted: null })).toBe(false);
  });

  it("访客关掉模型就不算已接入", () => {
    expect(modelAvailable({ settings: { modelEnabled: false, apiKey: "sk" }, hosted: true })).toBe(false);
  });

  it("模型名：自带 Key 用访客选的，共享额度用部署方托管的", () => {
    expect(displayModelName({ settings: { apiKey: "sk", modelName: "gpt-4o-mini" }, hosted: { model: "Qwen" } })).toBe("gpt-4o-mini");
    expect(
      displayModelName({ settings: { apiKey: "", modelName: "gpt-4o-mini" }, hosted: { model: "Qwen/Qwen3.5-35B-A3B" } })
    ).toBe("Qwen/Qwen3.5-35B-A3B");
    expect(displayModelName({ settings: { apiKey: "", modelName: "" }, hosted: false })).toBe("");
  });
});
