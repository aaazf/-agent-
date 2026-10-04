import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAccountHandlers } from "../server/account-routes.mjs";
import { hashToken } from "../server/auth.mjs";
import { createStore } from "../server/store.mjs";
import { callRoute, withToken } from "./support/http-stub.js";

const tempDirs = [];
const PASSWORD = "interview2026";

function newStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-accounts-"));
  tempDirs.push(dir);
  return createStore({ file: path.join(dir, "store.json") });
}

function build(store = newStore()) {
  return { store, routes: createAccountHandlers({ store }) };
}

async function register(routes, account, password = PASSWORD) {
  return callRoute(routes, "/api/auth/register", { account, password });
}

async function login(routes, account, password = PASSWORD) {
  return callRoute(routes, "/api/auth/login", { account, password });
}

// 认证接口上有"每 IP 每分钟 10 次"的限流。要单独验证"账号级锁定"就必须
// 让每个请求看起来来自不同 IP（攻击者本来也会换 IP），否则会先撞上 IP 限流。
let ipSeq = 0;
function nextIp() {
  ipSeq += 1;
  return { headers: { "x-forwarded-for": `203.0.113.${(ipSeq % 200) + 1}` } };
}

async function loginFromFreshIp(routes, account, password = PASSWORD) {
  return callRoute(routes, "/api/auth/login", { account, password }, nextIp());
}

afterEach(() => {
  vi.unstubAllEnvs();
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // 清理失败不影响断言
    }
  }
});

describe("register and login", () => {
  it("registers an account and hands back a working session token", async () => {
    const { routes } = build();
    const created = await register(routes, "Alice@Example.com");
    expect(created.status).toBe(200);
    expect(created.json.token).toBeTruthy();
    expect(created.json.user.account).toBe("alice@example.com");
    // 口令哈希绝不能出现在响应里
    expect(created.json.user.passwordHash).toBeUndefined();

    const me = await callRoute(routes, "/api/auth/me", null, withToken(created.json.token, { method: "GET" }));
    expect(me.status).toBe(200);
    expect(me.json.user.account).toBe("alice@example.com");
  });

  it("logs in with the same credentials and issues a fresh token", async () => {
    const { routes } = build();
    const created = await register(routes, "alice");
    const signedIn = await login(routes, "  ALICE ");
    expect(signedIn.status).toBe(200);
    expect(signedIn.json.token).not.toBe(created.json.token);
    expect(signedIn.json.user.id).toBe(created.json.user.id);
  });

  it("refuses a duplicate account", async () => {
    const { routes } = build();
    await register(routes, "alice");
    const again = await register(routes, "alice", "another2026");
    expect(again.status).toBe(409);
    expect(again.json.code).toBe("account_exists");
  });

  it("refuses a weak password and a malformed account", async () => {
    const { routes } = build();
    expect((await register(routes, "alice", "12345678")).status).toBe(400);
    expect((await register(routes, "alice", "abcdefgh")).status).toBe(400);
    expect((await register(routes, "-bad-", PASSWORD)).status).toBe(400);
  });

  it("refuses login for unknown accounts and wrong passwords with the same message", async () => {
    const { routes } = build();
    await register(routes, "alice");
    const missing = await login(routes, "nobody");
    const wrong = await login(routes, "alice", "wrong2026");
    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    // 不区分"账号不存在"和"密码错误"，避免被拿来枚举账号
    expect(missing.json.error).toBe(wrong.json.error);
  });

  it("locks a brute-forced account without touching other accounts", async () => {
    const { routes } = build();
    await register(routes, "alice");
    for (let i = 0; i < 8; i += 1) {
      expect((await loginFromFreshIp(routes, "target")).status).toBe(401);
    }
    // 就算换了 IP，被爆破的账号依然被按住——锁在账号上，不在 IP 上
    const blocked = await loginFromFreshIp(routes, "target");
    expect(blocked.status).toBe(429);
    expect(blocked.json.code).toBe("too_many_attempts");
    // 别的账号不受牵连（同一出口 IP 背后的同事还能正常登录）
    expect((await loginFromFreshIp(routes, "alice")).status).toBe(200);
  });

  it("clears the failure counter after a successful login", async () => {
    const { routes } = build();
    await register(routes, "alice");
    for (let i = 0; i < 7; i += 1) await loginFromFreshIp(routes, "alice", "wrong2026");
    expect((await loginFromFreshIp(routes, "alice")).status).toBe(200);
    // 计数没清掉的话，这里第 2 次就会撞上 8 次上限
    for (let i = 0; i < 4; i += 1) {
      expect((await loginFromFreshIp(routes, "alice", "wrong2026")).status).toBe(401);
    }
  });

  it("throttles a flood of auth requests from one address", async () => {
    const { routes } = build();
    // 账号格式非法时会在校验阶段就被拒，不会真的做哈希，所以这里很快
    for (let i = 0; i < 10; i += 1) {
      expect((await register(routes, "!", "short")).status).toBe(400);
    }
    const throttled = await register(routes, "!", "short");
    expect(throttled.status).toBe(429);
    expect(throttled.json.code).toBe("rate_limited");
  });

  it("honours ALLOW_SIGNUP=0 and SIGNUP_INVITE_CODE", async () => {
    vi.resetModules();
    vi.stubEnv("ALLOW_SIGNUP", "0");
    const closed = await import("../server/account-routes.mjs");
    expect(closed.signupStatus().signup).toBe(false);
    const closedRoutes = closed.createAccountHandlers({ store: newStore() });
    const refused = await register(closedRoutes, "alice");
    expect(refused.status).toBe(403);
    expect(refused.json.code).toBe("signup_disabled");

    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv("SIGNUP_INVITE_CODE", "let-me-in");
    const invited = await import("../server/account-routes.mjs");
    expect(invited.signupStatus().inviteRequired).toBe(true);
    const invitedRoutes = invited.createAccountHandlers({ store: newStore() });
    const noCode = await callRoute(invitedRoutes, "/api/auth/register", { account: "bob", password: PASSWORD });
    expect(noCode.status).toBe(403);
    expect(noCode.json.code).toBe("invite_required");
    const withCode = await callRoute(invitedRoutes, "/api/auth/register", {
      account: "bob",
      password: PASSWORD,
      inviteCode: "let-me-in"
    });
    expect(withCode.status).toBe(200);
    vi.resetModules();
  });
});

describe("sessions", () => {
  it("rejects missing, unknown and expired tokens", async () => {
    const { store, routes } = build();
    const created = await register(routes, "alice");
    expect((await callRoute(routes, "/api/auth/me", null, { method: "GET" })).status).toBe(401);
    expect((await callRoute(routes, "/api/auth/me", null, withToken("not-a-token", { method: "GET" }))).status).toBe(401);

    store.sessions.create({
      userId: created.json.user.id,
      tokenHash: hashToken("stale-token"),
      expiresAt: Date.now() - 1
    });
    const stale = await callRoute(routes, "/api/auth/me", null, withToken("stale-token", { method: "GET" }));
    expect(stale.status).toBe(401);
    expect(stale.json.code).toBe("session_expired");
  });

  it("invalidates the token on logout and stays idempotent", async () => {
    const { routes } = build();
    const created = await register(routes, "alice");
    const token = created.json.token;
    expect((await callRoute(routes, "/api/auth/logout", {}, withToken(token))).status).toBe(200);
    expect((await callRoute(routes, "/api/auth/me", null, withToken(token, { method: "GET" }))).status).toBe(401);
    expect((await callRoute(routes, "/api/auth/logout", {}, {})).status).toBe(200);
  });
});

describe("resumes", () => {
  const resume = { text: "三年 React / TypeScript 经验", jd: "熟悉 React 与工程化", role: "前端工程师" };

  it("saves, lists, updates and deletes a resume for its owner", async () => {
    const { routes } = build();
    const token = (await register(routes, "alice")).json.token;
    const saved = await callRoute(routes, "/api/resumes", { resume }, withToken(token));
    expect(saved.status).toBe(200);
    expect(saved.json.resume.title).toBe("三年 React / TypeScript 经验");

    const listed = await callRoute(routes, "/api/resumes", null, withToken(token, { method: "GET" }));
    expect(listed.json.resumes).toHaveLength(1);

    const updated = await callRoute(
      routes,
      "/api/resumes",
      { resume: { id: saved.json.resume.id, text: "更新后的简历", jd: "" } },
      withToken(token)
    );
    expect(updated.json.resume.id).toBe(saved.json.resume.id);
    const relisted = await callRoute(routes, "/api/resumes", null, withToken(token, { method: "GET" }));
    expect(relisted.json.resumes).toHaveLength(1);
    expect(relisted.json.resumes[0].text).toBe("更新后的简历");

    const removed = await callRoute(routes, "/api/resumes/delete", { id: saved.json.resume.id }, withToken(token));
    expect(removed.status).toBe(200);
    const empty = await callRoute(routes, "/api/resumes", null, withToken(token, { method: "GET" }));
    expect(empty.json.resumes).toHaveLength(0);
  });

  it("keeps each account's resumes invisible to everyone else", async () => {
    const { routes } = build();
    const alice = (await register(routes, "alice")).json.token;
    const bob = (await register(routes, "bob")).json.token;
    const saved = await callRoute(routes, "/api/resumes", { resume }, withToken(alice));

    const bobList = await callRoute(routes, "/api/resumes", null, withToken(bob, { method: "GET" }));
    expect(bobList.json.resumes).toHaveLength(0);
    // 就算拿到了别人的简历 id，既读不到也删不掉
    const peek = await callRoute(routes, "/api/resumes", null, withToken(bob, { method: "GET" }));
    expect(JSON.stringify(peek.json)).not.toContain(saved.json.resume.id);
    const stolen = await callRoute(routes, "/api/resumes/delete", { id: saved.json.resume.id }, withToken(bob));
    expect(stolen.status).toBe(404);
    const stillThere = await callRoute(routes, "/api/resumes", null, withToken(alice, { method: "GET" }));
    expect(stillThere.json.resumes).toHaveLength(1);
  });

  it("requires a session and rejects empty or oversized resumes", async () => {
    const { routes } = build();
    const token = (await register(routes, "alice")).json.token;
    expect((await callRoute(routes, "/api/resumes", { resume }, {})).status).toBe(401);
    expect((await callRoute(routes, "/api/resumes", null, { method: "GET" })).status).toBe(401);
    expect((await callRoute(routes, "/api/resumes", { resume: { text: "   " } }, withToken(token))).status).toBe(400);
    const huge = await callRoute(routes, "/api/resumes", { resume: { text: "x".repeat(20001) } }, withToken(token));
    expect(huge.status).toBe(413);
  });
});

describe("data ownership", () => {
  it("exports only the caller's data", async () => {
    const { routes } = build();
    const alice = (await register(routes, "alice")).json.token;
    const bob = (await register(routes, "bob")).json.token;
    await callRoute(routes, "/api/resumes", { resume: { text: "alice 的简历" } }, withToken(alice));
    await callRoute(routes, "/api/resumes", { resume: { text: "bob 的简历" } }, withToken(bob));

    const exported = await callRoute(routes, "/api/account/export", null, withToken(alice, { method: "GET" }));
    expect(exported.status).toBe(200);
    expect(exported.json.user.account).toBe("alice");
    expect(exported.json.resumes).toHaveLength(1);
    expect(JSON.stringify(exported.json)).not.toContain("bob 的简历");
  });

  it("deletes the account, its sessions and its resumes after password check", async () => {
    const { store, routes } = build();
    const created = await register(routes, "alice");
    const token = created.json.token;
    await callRoute(routes, "/api/resumes", { resume: { text: "alice 的简历" } }, withToken(token));

    const wrong = await callRoute(routes, "/api/account/delete", { password: "wrong2026" }, withToken(token));
    expect(wrong.status).toBe(403);
    expect(store.users.count()).toBe(1);

    const removed = await callRoute(routes, "/api/account/delete", { password: PASSWORD }, withToken(token));
    expect(removed.status).toBe(200);
    expect(store.users.count()).toBe(0);
    expect(store.resumes.count()).toBe(0);
    expect(store.sessions.countByUser(created.json.user.id)).toBe(0);
    // 注销之后连原 token 也不该能用
    expect((await callRoute(routes, "/api/auth/me", null, withToken(token, { method: "GET" }))).status).toBe(401);
    expect((await login(routes, "alice")).status).toBe(401);
  });
});
