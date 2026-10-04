// 账号 / 会话 / 简历的持久层。
//
// 为什么是"零依赖的文件型 JSON"：
//   1) 容器基座是 node:20（没有内置 node:sqlite，22.5 才引入），装 better-sqlite3 需要
//      编译工具链，在创空间镜像里属于"编译失败就整个部署失败"的高风险项；
//   2) 本项目的定位是社区体验站，数据量级是"几百个账号 + 每账号几份简历"，
//      单进程同步写一个小 JSON 完全够用，且没有外部依赖、没有迁移脚本、没有运维面；
//   3) 接口刻意收窄在 users / sessions / resumes 三个命名空间里，
//      将来换成 SQLite/Postgres 只需要替换本文件的实现，路由与前端不用动。
//
// 已知边界（文档里也写了）：单进程、全量读入内存、写入是全量覆盖。
// 真要做多实例或万级账号，必须换掉这个实现。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { projectRoot } from "./env.mjs";

export const STORE_VERSION = 1;
// 社区体验站的护栏：避免被脚本批量注册把内存和磁盘撑爆。
export const MAX_USERS = 5000;
export const MAX_RESUMES_PER_USER = 50;
export const MAX_SESSIONS_PER_USER = 20;

export function defaultStoreFile() {
  const explicit = String(process.env.STORE_FILE || "").trim();
  if (explicit) return path.resolve(explicit);
  const dir = String(process.env.DATA_DIR || "").trim();
  return path.resolve(dir || path.join(projectRoot, "data"), "store.json");
}

function emptyData() {
  return { version: STORE_VERSION, users: {}, sessions: {}, resumes: {} };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// 兜底归一化：文件被手工改坏、版本升级时，也要能启动，而不是整个服务起不来。
function normalize(raw) {
  const data = emptyData();
  if (!isPlainObject(raw)) return data;
  for (const name of ["users", "sessions", "resumes"]) {
    if (isPlainObject(raw[name])) data[name] = raw[name];
  }
  return data;
}

export function createStore({ file = defaultStoreFile(), now = () => Date.now() } = {}) {
  let data = emptyData();
  let persistent = false;
  let reason = "";

  function load() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (fs.existsSync(file)) {
        const raw = fs.readFileSync(file, "utf8");
        data = normalize(JSON.parse(raw));
      }
      // 探针写：挂载卷只读 / 无写权限是公开部署里最常见的故障，
      // 启动时就确认一次，比"用户注册到一半才发现写不进去"划算得多。
      const probe = `${file}.probe`;
      fs.writeFileSync(probe, "ok", "utf8");
      fs.unlinkSync(probe);
      persistent = true;
    } catch (err) {
      if (err instanceof SyntaxError && fs.existsSync(file)) {
        // 内容损坏：留一份现场再重来，避免"每次都从空开始还查不出原因"。
        const backup = `${file}.corrupt-${now()}`;
        try {
          fs.renameSync(file, backup);
          data = emptyData();
          persistent = true;
          reason = `数据文件解析失败，已备份到 ${path.basename(backup)}`;
          return;
        } catch {
          // 备份也失败就落到下面的不可写分支
        }
      }
      persistent = false;
      reason = err?.message || String(err);
    }
  }

  load();

  function persist() {
    if (!persistent) return false;
    try {
      // 先写临时文件再 rename：进程被杀也不会留下半截 JSON。
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
      fs.renameSync(tmp, file);
      return true;
    } catch (err) {
      persistent = false;
      reason = `写入失败：${err?.message || String(err)}`;
      return false;
    }
  }

  const sessions = {
    create({ userId, tokenHash, createdAt = now(), expiresAt, agent = "" }) {
      const hash = String(tokenHash || "");
      if (!hash || !users.byId(userId)) return null;
      // 同一账号最多留 N 个会话：换设备够用，同时给"token 泄漏后无限堆积"留个上限。
      const mine = Object.values(data.sessions).filter((item) => item.userId === userId);
      if (mine.length >= MAX_SESSIONS_PER_USER) {
        mine.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
        delete data.sessions[mine[0].tokenHash];
      }
      const session = { tokenHash: hash, userId, createdAt, lastSeenAt: createdAt, expiresAt, agent };
      data.sessions[hash] = session;
      persist();
      return session;
    },
    // 过期即视为不存在（顺手删掉），调用方不用自己判断 expiresAt。
    byTokenHash(tokenHash) {
      const key = String(tokenHash || "");
      const session = data.sessions[key];
      if (!session) return null;
      if (Number(session.expiresAt || 0) <= now()) {
        delete data.sessions[key];
        persist();
        return null;
      }
      return session;
    },
    countByUser(userId) {
      return Object.values(data.sessions).filter((item) => item.userId === userId).length;
    },
    count() {
      return Object.keys(data.sessions).length;
    },
    touch(tokenHash, { ttlMs, refreshAfterMs = 60 * 60 * 1000 } = {}) {
      const key = String(tokenHash || "");
      const session = data.sessions[key];
      if (!session) return null;
      const ts = now();
      // 每次请求都写盘会把磁盘打满，所以按小时续期一次即可。
      if (ttlMs && ts - Number(session.lastSeenAt || 0) > refreshAfterMs) {
        session.lastSeenAt = ts;
        session.expiresAt = ts + ttlMs;
        persist();
      }
      return session;
    },
    remove(tokenHash) {
      const key = String(tokenHash || "");
      if (!data.sessions[key]) return false;
      delete data.sessions[key];
      persist();
      return true;
    },
    removeByUser(userId) {
      let removed = 0;
      for (const [key, session] of Object.entries(data.sessions)) {
        if (session.userId === userId) {
          delete data.sessions[key];
          removed += 1;
        }
      }
      return removed;
    },
    prune() {
      const ts = now();
      let removed = 0;
      for (const [key, session] of Object.entries(data.sessions)) {
        if (Number(session.expiresAt || 0) <= ts) {
          delete data.sessions[key];
          removed += 1;
        }
      }
      if (removed) persist();
      return removed;
    }
  };

  const resumes = {
    // 归属过滤放在存储层：越权不是"路由忘了判断"就能绕过的事。
    list(userId) {
      return Object.values(data.resumes)
        .filter((item) => item.userId === userId)
        .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
    },
    get(userId, id) {
      const item = data.resumes[String(id || "")];
      if (!item || item.userId !== userId) return null;
      return item;
    },
    countByUser(userId) {
      return Object.values(data.resumes).filter((item) => item.userId === userId).length;
    },
    count() {
      return Object.keys(data.resumes).length;
    },
    upsert(userId, input = {}) {
      const ts = now();
      const existing = resumes.get(userId, input.id);
      if (existing) {
        Object.assign(existing, input, { userId, updatedAt: ts });
        persist();
        return existing;
      }
      if (resumes.countByUser(userId) >= MAX_RESUMES_PER_USER) return null;
      const id = String(input.id || "") || `r_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
      const record = { ...input, id, userId, createdAt: ts, updatedAt: ts };
      data.resumes[id] = record;
      persist();
      return record;
    },
    remove(userId, id) {
      const key = String(id || "");
      const item = data.resumes[key];
      if (!item || item.userId !== userId) return false;
      delete data.resumes[key];
      persist();
      return true;
    },
    removeByUser(userId) {
      for (const [key, item] of Object.entries(data.resumes)) {
        if (item.userId === userId) delete data.resumes[key];
      }
    }
  };

  const users = {
    byAccount(account) {
      const target = String(account || "");
      return Object.values(data.users).find((user) => user.account === target) || null;
    },
    byId(id) {
      return data.users[String(id || "")] || null;
    },
    count() {
      return Object.keys(data.users).length;
    },
    create({ account, passwordHash, createdAt = now() }) {
      const normalized = String(account || "");
      if (!normalized || users.byAccount(normalized)) return null;
      if (users.count() >= MAX_USERS) return null;
      const id = `u_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
      const user = {
        id,
        account: normalized,
        passwordHash,
        createdAt,
        updatedAt: createdAt
      };
      data.users[id] = user;
      persist();
      return user;
    },
    update(id, patch = {}) {
      const user = users.byId(id);
      if (!user) return null;
      Object.assign(user, patch, { updatedAt: now() });
      persist();
      return user;
    },
    remove(id) {
      const key = String(id || "");
      if (!data.users[key]) return false;
      delete data.users[key];
      sessions.removeByUser(key);
      resumes.removeByUser(key);
      persist();
      return true;
    }
  };

  return {
    file,
    users,
    sessions,
    resumes,
    get persistent() {
      return persistent;
    },
    status() {
      return {
        persistent,
        reason,
        file,
        users: users.count(),
        sessions: sessions.count(),
        resumes: resumes.count()
      };
    },
    // 仅供测试与运维脚本：把内存里的内容立刻落盘。
    flush: persist
  };
}

let singleton = null;

// 单例：Vite 中间件与独立服务器共用同一份内存状态，
// 否则开发模式下同一个进程里会出现"两套账号"。
export function getStore() {
  if (!singleton) singleton = createStore();
  return singleton;
}

export function resetStoreCache() {
  singleton = null;
}
