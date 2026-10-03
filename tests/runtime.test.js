import { afterEach, describe, expect, it, vi } from "vitest";
import { isEmbedded, openInNewWindow } from "../src/lib/runtime.js";

describe("isEmbedded", () => {
  afterEach(() => {
    Object.defineProperty(window, "top", { value: window, configurable: true, writable: true });
  });

  it("returns false in a top-level window", () => {
    Object.defineProperty(window, "top", { value: window, configurable: true, writable: true });
    expect(isEmbedded()).toBe(false);
  });

  it("returns true when the page is framed", () => {
    Object.defineProperty(window, "top", { value: {}, configurable: true, writable: true });
    expect(isEmbedded()).toBe(true);
  });

  it("returns true when reaching the parent throws", () => {
    Object.defineProperty(window, "top", {
      configurable: true,
      get() {
        throw new Error("cross-origin");
      }
    });
    expect(isEmbedded()).toBe(true);
  });
});

describe("openInNewWindow", () => {
  it("opens the current url in a new tab without leaking the referrer", () => {
    const open = vi.fn();
    const original = window.open;
    window.open = open;
    openInNewWindow();
    expect(open).toHaveBeenCalledWith(window.location.href, "_blank", "noopener,noreferrer");
    window.open = original;
  });
});

describe("fetchHealth / hasHostedQuota", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("reports a disabled hosted quota when the server says so", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, hostedLlm: { enabled: false } }) })));
    const mod = await import("../src/lib/runtime.js");
    await expect(mod.hasHostedQuota()).resolves.toBe(false);
  });

  it("reports an enabled hosted quota and caches the health call", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, hostedLlm: { enabled: true, model: "Qwen/Qwen3-8B" } }) }));
    vi.stubGlobal("fetch", fetchMock);
    const mod = await import("../src/lib/runtime.js");
    await expect(mod.hasHostedQuota()).resolves.toBe(true);
    await mod.fetchHealth();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("degrades to false when the health endpoint is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("offline");
    }));
    const mod = await import("../src/lib/runtime.js");
    await expect(mod.hasHostedQuota()).resolves.toBe(false);
  });
});
