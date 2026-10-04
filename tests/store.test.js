import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_RESUMES_PER_USER, MAX_SESSIONS_PER_USER, createStore } from "../server/store.mjs";

const tempDirs = [];

function tempFile(name = "store.json") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-store-"));
  tempDirs.push(dir);
  return path.join(dir, name);
}

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // 清理失败不影响断言
    }
  }
});

function seedUser(store, account, passwordHash = "hash-x") {
  const user = store.users.create({ account, passwordHash });
  if (!user) throw new Error("建号失败");
  return user;
}

describe("store persistence", () => {
  it("writes a data file that a fresh store instance reads back", () => {
    const file = tempFile();
    const store = createStore({ file });
    expect(store.persistent).toBe(true);
    const user = seedUser(store, "alice");
    store.sessions.create({ userId: user.id, tokenHash: "hash-1", expiresAt: Date.now() + 1000 });
    store.resumes.upsert(user.id, { text: "三年 React 经验", jd: "前端", title: "前端简历" });
    store.flush();

    const reopened = createStore({ file });
    expect(reopened.users.byAccount("alice")?.id).toBe(user.id);
    expect(reopened.sessions.byTokenHash("hash-1")?.userId).toBe(user.id);
    expect(reopened.resumes.list(user.id)).toHaveLength(1);
    expect(reopened.resumes.list(user.id)[0].text).toBe("三年 React 经验");
  });

  it("starts empty when the file does not exist yet", () => {
    const store = createStore({ file: tempFile("missing.json") });
    expect(store.persistent).toBe(true);
    expect(store.status().users).toBe(0);
  });

  it("backs up a corrupt file instead of failing to boot", () => {
    const file = tempFile();
    fs.writeFileSync(file, "{ this is not json", "utf8");
    const store = createStore({ file });
    expect(store.persistent).toBe(true);
    expect(store.status().users).toBe(0);
    expect(store.status().reason).toContain("解析失败");
    const backups = fs.readdirSync(path.dirname(file)).filter((name) => name.includes(".corrupt-"));
    expect(backups).toHaveLength(1);
  });

  it("degrades to memory-only when the path is not writable", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-store-"));
    tempDirs.push(dir);
    const blocker = path.join(dir, "blocker");
    fs.writeFileSync(blocker, "not a directory", "utf8");
    const store = createStore({ file: path.join(blocker, "store.json") });
    expect(store.persistent).toBe(false);
    expect(store.status().reason).toBeTruthy();
    // 关键：写不进去也必须能继续提供注册/登录（只是重启后丢），不能直接 500。
    const user = store.users.create({ account: "bob", passwordHash: "hash-y" });
    expect(user.account).toBe("bob");
    expect(store.users.byAccount("bob")).not.toBeNull();
    expect(store.flush()).toBe(false);
  });
});

describe("store users", () => {
  it("rejects duplicate accounts regardless of case handling upstream", () => {
    const store = createStore({ file: tempFile() });
    seedUser(store, "alice");
    expect(store.users.create({ account: "alice", passwordHash: "other" })).toBeNull();
    expect(store.users.count()).toBe(1);
  });

  it("removes a user together with sessions and resumes", () => {
    const store = createStore({ file: tempFile() });
    const user = seedUser(store, "alice");
    store.sessions.create({ userId: user.id, tokenHash: "hash-1", expiresAt: Date.now() + 1000 });
    store.resumes.upsert(user.id, { text: "resume" });
    expect(store.users.remove(user.id)).toBe(true);
    expect(store.users.byId(user.id)).toBeNull();
    expect(store.sessions.byTokenHash("hash-1")).toBeNull();
    expect(store.resumes.list(user.id)).toHaveLength(0);
  });
});

describe("store sessions", () => {
  it("treats an expired session as absent and drops it", () => {
    const store = createStore({ file: tempFile() });
    const user = seedUser(store, "alice");
    store.sessions.create({ userId: user.id, tokenHash: "old", expiresAt: Date.now() - 1 });
    expect(store.sessions.byTokenHash("old")).toBeNull();
    expect(store.sessions.count()).toBe(0);
  });

  it("refuses to create a session for an unknown user", () => {
    const store = createStore({ file: tempFile() });
    expect(store.sessions.create({ userId: "u_missing", tokenHash: "h", expiresAt: Date.now() + 1000 })).toBeNull();
  });

  it("extends expiry on touch but not more than once an hour", () => {
    let now = 1_000_000;
    const store = createStore({ file: tempFile(), now: () => now });
    const user = seedUser(store, "alice");
    const ttlMs = 1_000_000_000;
    store.sessions.create({ userId: user.id, tokenHash: "h", createdAt: now, expiresAt: now + ttlMs });

    // 超过一小时才续期：避免每个请求都写一次盘
    now += 3_700_000;
    store.sessions.touch("h", { ttlMs });
    expect(store.sessions.byTokenHash("h").expiresAt).toBe(now + ttlMs);

    const before = store.sessions.byTokenHash("h").expiresAt;
    now += 1000;
    store.sessions.touch("h", { ttlMs });
    expect(store.sessions.byTokenHash("h").expiresAt).toBe(before);
  });

  it("keeps at most MAX_SESSIONS_PER_USER sessions per account", () => {
    const store = createStore({ file: tempFile() });
    const user = seedUser(store, "alice");
    for (let i = 0; i < MAX_SESSIONS_PER_USER + 3; i += 1) {
      store.sessions.create({ userId: user.id, tokenHash: `h-${i}`, expiresAt: Date.now() + 60_000 });
    }
    expect(store.sessions.countByUser(user.id)).toBe(MAX_SESSIONS_PER_USER);
  });

  it("prunes expired sessions in bulk", () => {
    const store = createStore({ file: tempFile() });
    const user = seedUser(store, "alice");
    store.sessions.create({ userId: user.id, tokenHash: "live", expiresAt: Date.now() + 60_000 });
    store.sessions.create({ userId: user.id, tokenHash: "dead", expiresAt: Date.now() - 60_000 });
    expect(store.sessions.prune()).toBe(1);
    expect(store.sessions.count()).toBe(1);
  });
});

describe("store resumes", () => {
  it("keeps resumes scoped to their owner", () => {
    const store = createStore({ file: tempFile() });
    const alice = seedUser(store, "alice");
    const bob = seedUser(store, "bob");
    const saved = store.resumes.upsert(alice.id, { text: "alice 的简历", jd: "" });
    expect(store.resumes.list(alice.id)).toHaveLength(1);
    expect(store.resumes.list(bob.id)).toHaveLength(0);
    // 拿到 id 也不能跨账号读取 / 删除
    expect(store.resumes.get(bob.id, saved.id)).toBeNull();
    expect(store.resumes.remove(bob.id, saved.id)).toBe(false);
    expect(store.resumes.get(alice.id, saved.id)).not.toBeNull();
  });

  it("updates an existing resume in place and bumps updatedAt", () => {
    let now = 5_000;
    const store = createStore({ file: tempFile(), now: () => now });
    const user = seedUser(store, "alice");
    const created = store.resumes.upsert(user.id, { text: "v1", title: "前端" });
    const createdAt = created.updatedAt;
    now += 1000;
    const updated = store.resumes.upsert(user.id, { id: created.id, text: "v2", title: "前端" });
    expect(updated.id).toBe(created.id);
    expect(updated.text).toBe("v2");
    expect(updated.updatedAt).toBeGreaterThan(createdAt);
    expect(store.resumes.list(user.id)).toHaveLength(1);
  });

  it("caps how many resumes one account can keep", () => {
    const store = createStore({ file: tempFile() });
    const user = seedUser(store, "alice");
    for (let i = 0; i < MAX_RESUMES_PER_USER; i += 1) {
      expect(store.resumes.upsert(user.id, { text: `resume ${i}` })).not.toBeNull();
    }
    expect(store.resumes.upsert(user.id, { text: "overflow" })).toBeNull();
    expect(store.resumes.countByUser(user.id)).toBe(MAX_RESUMES_PER_USER);
  });

  it("lists newest first", () => {
    let now = 1_000;
    const store = createStore({ file: tempFile(), now: () => now });
    const user = seedUser(store, "alice");
    const first = store.resumes.upsert(user.id, { text: "第一份" });
    now += 10_000;
    const second = store.resumes.upsert(user.id, { text: "第二份" });
    expect(store.resumes.list(user.id).map((item) => item.id)).toEqual([second.id, first.id]);
  });
});
