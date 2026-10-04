import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ResumeLibrary from "../src/components/ResumeLibrary.jsx";
import { saveToken } from "../src/lib/auth.js";
import { setStorageScope } from "../src/lib/storage.js";

const SAVED = {
  id: "r_1",
  title: "互联网·前端工程师",
  role: "前端工程师",
  direction: "互联网",
  text: "三年 React 经验",
  jd: "React",
  updatedAt: Date.now()
};

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

// 按"URL + 方法"路由的 fetch 桩：保存流程是先 POST 再 GET 列表，
// 用队列式桩会把顺序写死，反而掩盖真实调用。
function routeFetch(handler) {
  const calls = [];
  vi.stubGlobal("fetch", async (url, init) => {
    const method = String(init?.method || "GET").toUpperCase();
    calls.push({ url, method, body: init?.body });
    return handler({ url, method });
  });
  return calls;
}

function renderLibrary(props = {}) {
  return render(
    createElement(ResumeLibrary, {
      current: { title: "互联网·前端工程师", role: "前端工程师", direction: "互联网", text: "三年 React 经验", jd: "React" },
      ...props
    })
  );
}

beforeEach(() => {
  localStorage.clear();
  saveToken("tok-1");
  setStorageScope("alice");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("简历库", () => {
  it("保存成功后提示不会被紧随其后的列表刷新覆盖", async () => {
    let saved = false;
    routeFetch(({ url, method }) => {
      if (url !== "/api/resumes") throw new Error(`意外请求 ${method} ${url}`);
      if (method === "POST") {
        saved = true;
        return jsonResponse({ resume: SAVED });
      }
      return jsonResponse({ resumes: saved ? [SAVED] : [] });
    });
    renderLibrary();
    await waitFor(() => expect(screen.getByText(/还没有保存过简历/)).toBeTruthy());

    fireEvent.click(screen.getByText("保存当前简历"));
    // 回归点：refresh() 曾经把刚设置的"已保存到账号"清成空串，
    // 访客点完保存看不到任何成功反馈。
    await waitFor(() => expect(screen.getByText(/已保存到账号：互联网·前端工程师/)).toBeTruthy());
    await waitFor(() => expect(screen.getByText("互联网·前端工程师")).toBeTruthy());
    expect(screen.getByText(/已保存到账号/)).toBeTruthy();
  });

  it("列表读不回来时给出告警并回落到本机缓存", async () => {
    routeFetch(() => {
      throw new Error("boom");
    });
    renderLibrary();
    await waitFor(() => expect(screen.getByText(/无法连接服务端/)).toBeTruthy());
  });

  it("载入会把那份简历交给上层，并显示已载入", async () => {
    routeFetch(() => jsonResponse({ resumes: [SAVED] }));
    const onLoad = vi.fn();
    renderLibrary({ onLoad });
    await waitFor(() => expect(screen.getByText("互联网·前端工程师")).toBeTruthy());
    fireEvent.click(screen.getByText("载入"));
    await waitFor(() => expect(onLoad).toHaveBeenCalledWith(SAVED));
    expect(screen.getByText(/已载入：互联网·前端工程师/)).toBeTruthy();
  });

  it("删除需要确认，删除后列表与服务端缓存同步清空", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    let deleted = false;
    const calls = routeFetch(({ url }) => {
      if (url === "/api/resumes/delete") {
        deleted = true;
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ resumes: deleted ? [] : [SAVED] });
    });
    renderLibrary();
    await waitFor(() => expect(screen.getByText("互联网·前端工程师")).toBeTruthy());
    fireEvent.click(screen.getByText("删除"));
    await waitFor(() => expect(screen.getByText("已删除。")).toBeTruthy());
    expect(calls.some((call) => call.url === "/api/resumes/delete")).toBe(true);
    await waitFor(() => expect(screen.getByText(/还没有保存过简历/)).toBeTruthy());
  });

  it("内容为空时拒绝保存并说明原因", async () => {
    const calls = routeFetch(() => jsonResponse({ resumes: [] }));
    renderLibrary({ current: { text: "   ", jd: "" } });
    await waitFor(() => expect(screen.getByText(/还没有保存过简历/)).toBeTruthy());
    fireEvent.click(screen.getByText("保存当前简历"));
    await waitFor(() => expect(screen.getByText(/简历内容还是空的/)).toBeTruthy());
    // 只有列表那一次 GET，没有发出保存请求
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });
});
