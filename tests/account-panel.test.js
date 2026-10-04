import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AccountDataPanel from "../src/components/AccountDataPanel.jsx";
import { saveToken } from "../src/lib/auth.js";

// 用例文件名必须是 .test.js（vitest 的 include），而 .js 里不转换 JSX，
// 所以这里统一用 createElement。
function renderPanel(props = {}) {
  return render(createElement(AccountDataPanel, props));
}

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

function stubFetch(...responses) {
  const calls = [];
  const queue = [...responses];
  vi.stubGlobal("fetch", async (url, init) => {
    calls.push({ url, init });
    const next = queue.shift();
    if (!next) throw new Error("fetch 桩没有更多响应了");
    return next;
  });
  return calls;
}

beforeEach(() => {
  localStorage.clear();
  saveToken("tok-1");
  // jsdom 没实现这两个 API，导出流程在真实浏览器里会用到
  vi.stubGlobal("URL", { ...URL, createObjectURL: vi.fn(() => "blob:mock"), revokeObjectURL: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("账号与数据面板", () => {
  it("显示当前账号，并说明数据存在服务端、密码只存哈希", () => {
    renderPanel({ account: "zhangsan" });
    expect(screen.getByText("zhangsan")).toBeTruthy();
    expect(screen.getByText(/哈希/)).toBeTruthy();
    expect(screen.getByText(/一直保留到你主动删除或注销/)).toBeTruthy();
  });

  it("导出时把账号信息与简历下载成 JSON", async () => {
    const calls = stubFetch(jsonResponse({ user: { account: "zhangsan" }, resumes: [{ id: "r1" }, { id: "r2" }] }));
    renderPanel({ account: "zhangsan" });
    fireEvent.click(screen.getByText("导出账号数据"));
    await waitFor(() => expect(screen.getByText(/已导出账号信息与 2 份简历/)).toBeTruthy());
    expect(calls[0].url).toBe("/api/account/export");
    expect(calls[0].init.headers.Authorization).toBe("Bearer tok-1");
    expect(URL.createObjectURL).toHaveBeenCalled();
  });

  it("导出失败时如实报错，不假装成功", async () => {
    stubFetch(jsonResponse({ error: "登录状态已过期，请重新登录" }, { ok: false, status: 401 }));
    renderPanel({ account: "zhangsan" });
    fireEvent.click(screen.getByText("导出账号数据"));
    await waitFor(() => expect(screen.getByText("登录状态已过期，请重新登录")).toBeTruthy());
  });

  it("注销需要输入密码并二次确认，成功后通知上层", async () => {
    const onDeleted = vi.fn();
    vi.spyOn(window, "prompt").mockReturnValue("interview2026");
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const calls = stubFetch(jsonResponse({ ok: true }));
    renderPanel({ account: "zhangsan", onDeleted });
    fireEvent.click(screen.getByText("注销账号"));
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
    expect(JSON.parse(calls[0].init.body)).toEqual({ password: "interview2026" });
  });

  it("用户取消输入密码时不会发出注销请求", () => {
    vi.spyOn(window, "prompt").mockReturnValue(null);
    const calls = stubFetch();
    const onDeleted = vi.fn();
    renderPanel({ account: "zhangsan", onDeleted });
    fireEvent.click(screen.getByText("注销账号"));
    expect(calls).toHaveLength(0);
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it("密码错误时把服务端的拒绝原因显示出来", async () => {
    vi.spyOn(window, "prompt").mockReturnValue("wrong2026");
    vi.spyOn(window, "confirm").mockReturnValue(true);
    stubFetch(jsonResponse({ error: "密码不正确，无法注销账号。", code: "invalid_credentials" }, { ok: false, status: 403 }));
    const onDeleted = vi.fn();
    renderPanel({ account: "zhangsan", onDeleted });
    fireEvent.click(screen.getByText("注销账号"));
    await waitFor(() => expect(screen.getByText("密码不正确，无法注销账号。")).toBeTruthy());
    expect(onDeleted).not.toHaveBeenCalled();
  });
});
