import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  clearToken,
  loadToken,
  loginAccount,
  logoutAccount,
  onUnauthorized,
  registerAccount,
  request,
  restoreSession,
  saveToken
} from "../src/lib/auth.js";
import { deleteResume, isSameResume, listResumes, saveResume, toResumePayload } from "../src/lib/resumes.js";
import { clearStorageScope, setStorageScope } from "../src/lib/storage.js";

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => body
  };
}

// fetch 桩：按调用顺序返回预设响应，并记录每次请求
function stubFetch(...responses) {
  const calls = [];
  const queue = [...responses];
  vi.stubGlobal("fetch", async (url, init) => {
    calls.push({ url, init });
    const next = queue.shift();
    if (!next) throw new Error("fetch 桩没有更多响应了");
    if (next instanceof Error) throw next;
    return next;
  });
  return calls;
}

beforeEach(() => {
  localStorage.clear();
  clearStorageScope();
  setStorageScope("alice");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("认证请求封装", () => {
  it("用 X-Auth-Token 头带登录态（Authorization 会被 ModelScope 网关 403）", async () => {
    saveToken("tok-1");
    const calls = stubFetch(jsonResponse({ ok: true }));
    await request("/api/auth/logout", { body: {} });
    expect(calls[0].init.headers["X-Auth-Token"]).toBe("tok-1");
    expect(calls[0].init.headers.Authorization).toBeUndefined();
  });

  it("把后端的错误码与状态透出来", async () => {
    stubFetch(jsonResponse({ error: "该账号已注册，请直接登录。", code: "account_exists" }, { ok: false, status: 409 }));
    await expect(registerAccount({ account: "alice", password: "interview2026" })).rejects.toMatchObject({
      status: 409,
      code: "account_exists",
      message: "该账号已注册，请直接登录。"
    });
  });

  it("网络不通时报成 offline，而不是 401", async () => {
    stubFetch(new Error("Failed to fetch"));
    await expect(loginAccount({ account: "alice", password: "interview2026" })).rejects.toSatisfy(
      (err) => err instanceof ApiError && err.offline && err.code === "network_error"
    );
  });
});

describe("启动时的登录态恢复", () => {
  it("没有 token 时直接是匿名，不发请求", async () => {
    const calls = stubFetch();
    await expect(restoreSession()).resolves.toEqual({ status: "anonymous" });
    expect(calls).toHaveLength(0);
  });

  it("token 有效时带回账号信息", async () => {
    saveToken("tok-1");
    stubFetch(jsonResponse({ user: { id: "u_1", account: "alice" } }));
    const result = await restoreSession();
    expect(result.status).toBe("authenticated");
    expect(result.user.account).toBe("alice");
  });

  it("token 失效时清掉本地 token 并回到匿名", async () => {
    saveToken("tok-old");
    stubFetch(jsonResponse({ error: "登录状态已过期，请重新登录", code: "session_expired" }, { ok: false, status: 401 }));
    await expect(restoreSession()).resolves.toEqual({ status: "anonymous" });
    expect(loadToken()).toBe("");
  });

  it("服务端连不上时保留 token 并报 offline（不能把用户当成未登录）", async () => {
    saveToken("tok-1");
    stubFetch(new Error("boom"));
    const result = await restoreSession();
    expect(result.status).toBe("offline");
    expect(loadToken()).toBe("tok-1");
  });
});

describe("退出登录", () => {
  it("使用中的会话过期时清 token 并通知上层回登录页", async () => {
    saveToken("tok-1");
    const handleExpired = vi.fn();
    const off = onUnauthorized(handleExpired);
    stubFetch(jsonResponse({ error: "登录状态已过期，请重新登录", code: "session_expired" }, { ok: false, status: 401 }));
    await expect(request("/api/resumes", { method: "GET" })).rejects.toMatchObject({ status: 401 });
    expect(loadToken()).toBe("");
    expect(handleExpired).toHaveBeenCalledWith("session_expired");
    off();
  });

  it("登录接口的 401（密码错误）不该被当成会话过期", async () => {
    const handleExpired = vi.fn();
    const off = onUnauthorized(handleExpired);
    stubFetch(jsonResponse({ error: "账号或密码不正确。", code: "invalid_credentials" }, { ok: false, status: 401 }));
    await expect(loginAccount({ account: "alice", password: "x" })).rejects.toMatchObject({ status: 401 });
    expect(handleExpired).not.toHaveBeenCalled();
    off();
  });

  it("取消订阅后不再收到通知", async () => {
    saveToken("tok-1");
    const handleExpired = vi.fn();
    onUnauthorized(handleExpired)();
    stubFetch(jsonResponse({ error: "x", code: "session_expired" }, { ok: false, status: 401 }));
    await expect(request("/api/auth/me", { method: "GET" })).rejects.toBeTruthy();
    expect(handleExpired).not.toHaveBeenCalled();
  });

  it("即使服务端失败也要清掉本地 token", async () => {
    saveToken("tok-1");
    stubFetch(new Error("boom"));
    await logoutAccount();
    expect(loadToken()).toBe("");
  });

  it("没有 token 时也能安全退出", async () => {
    clearToken();
    stubFetch();
    await expect(logoutAccount()).resolves.toBeUndefined();
    expect(loadToken()).toBe("");
  });
});

describe("简历客户端", () => {
  const resume = { id: "r_1", title: "前端简历", role: "前端工程师", direction: "互联网", text: "三年 React 经验", jd: "React" };

  it("列表成功后写入本机缓存，离线时回落到缓存并标记 cached", async () => {
    stubFetch(jsonResponse({ resumes: [resume] }));
    const online = await listResumes();
    expect(online.resumes).toHaveLength(1);
    expect(online.cached).toBe(false);

    stubFetch(new Error("offline"));
    const offline = await listResumes();
    expect(offline.cached).toBe(true);
    expect(offline.resumes[0].id).toBe("r_1");
    expect(offline.error).toContain("无法连接服务端");
  });

  it("服务端返回 5xx 时不要假装成离线缓存", async () => {
    stubFetch(jsonResponse({ error: "服务端错误" }, { ok: false, status: 500 }));
    await expect(listResumes()).rejects.toMatchObject({ status: 500 });
  });

  it("删除成功后会同步清掉缓存里的那条", async () => {
    stubFetch(jsonResponse({ resumes: [resume] }));
    await listResumes();
    stubFetch(jsonResponse({ ok: true }));
    await deleteResume("r_1");
    stubFetch(new Error("offline"));
    const cached = await listResumes();
    expect(cached.resumes).toEqual([]);
  });

  it("保存只把白名单字段发出去", async () => {
    const calls = stubFetch(jsonResponse({ resume }));
    await saveResume({ ...resume, extraSecret: "should-not-be-sent", huge: "x".repeat(10) });
    const body = JSON.parse(calls[0].init.body);
    expect(Object.keys(body.resume).sort()).toEqual(["analysis", "direction", "id", "jd", "role", "text", "title"]);
    expect(body.resume.extraSecret).toBeUndefined();
  });

  it("内容相同就认为是同一份简历（避免开始面试时反复堆副本）", () => {
    const payload = toResumePayload(resume);
    expect(isSameResume(payload, { ...payload, id: "r_2", title: "改了标题" })).toBe(true);
    expect(isSameResume(payload, { ...payload, text: "换了内容" })).toBe(false);
    expect(isSameResume(payload, null)).toBe(false);
  });
});
