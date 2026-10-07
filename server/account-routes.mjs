// 账号与简历接口：注册 / 登录 / 退出 / 会话自检 / 简历增删查 / 数据导出与注销。
//
// 设计取舍：
//   * 登录态用 `X-Auth-Token: <token>` 承载（见 auth.mjs 里的说明），
//     不用 Cookie——创空间是内嵌 iframe，第三方 Cookie 会被浏览器拦掉；
//     也不用 Authorization——ModelScope 的网关会把带该头的请求回 403。
//   * 口令只存 scrypt 哈希，token 只存 sha256 哈希，两者都不落明文。
//   * 简历的归属判断放在 store 层（按 userId 过滤），路由层再兜一层，
//     避免"哪个 handler 忘了校验"就变成任意用户读取他人简历。
import {
  createSessionToken,
  hashPassword,
  hashToken,
  normalizeAccount,
  readAuthToken,
  validateAccount,
  validatePassword,
  verifyPassword
} from "./auth.mjs";
import { HttpError, numberFromEnv, readJsonBody, sendJson, fail } from "./http.mjs";
import { clientKey, createDailyBudget, createSlidingWindowLimiter } from "./quota.mjs";
import { getStore } from "./store.mjs";

// 注册开关：社区站默认开放，但部署方可以用 ALLOW_SIGNUP=0 关掉（例如只给内部用）。
const ALLOW_SIGNUP = String(process.env.ALLOW_SIGNUP ?? "1") !== "0";
// 可选邀请码：公开体验站最怕被脚本批量注册，一个共享口令就能挡掉绝大多数。
const SIGNUP_INVITE_CODE = String(process.env.SIGNUP_INVITE_CODE || "").trim();
const SESSION_TTL_MS = Math.max(1, numberFromEnv("SESSION_TTL_DAYS", 30)) * 24 * 60 * 60 * 1000;
const AUTH_REQUESTS_PER_MINUTE = numberFromEnv("AUTH_REQUESTS_PER_MINUTE", 10);
const SIGNUPS_PER_DAY = numberFromEnv("SIGNUPS_PER_DAY", 200);
const LOGIN_FAILURES_PER_WINDOW = numberFromEnv("LOGIN_FAILURES_PER_15MIN", 8);

export const MAX_RESUME_TEXT = 20000;
export const MAX_JD_TEXT = 4000;
const MAX_RESUME_TITLE = 60;
const MAX_ANALYSIS_JSON = 8000;

export const ACCOUNT_ROUTE_METHODS = {
  "/api/auth/register": ["POST"],
  "/api/auth/login": ["POST"],
  "/api/auth/logout": ["POST"],
  "/api/auth/me": ["GET"],
  "/api/resumes": ["GET", "POST"],
  "/api/resumes/delete": ["POST"],
  "/api/account/export": ["GET"],
  "/api/account/delete": ["POST"]
};

export function publicUser(user) {
  return { id: user.id, account: user.account, createdAt: user.createdAt };
}

export function signupStatus() {
  return {
    signup: ALLOW_SIGNUP,
    inviteRequired: ALLOW_SIGNUP && Boolean(SIGNUP_INVITE_CODE),
    sessionTtlDays: Math.round(SESSION_TTL_MS / 24 / 60 / 60 / 1000)
  };
}

function firstLine(text) {
  const line = String(text || "").split(/\r?\n/).map((item) => item.trim()).find(Boolean) || "";
  return line.slice(0, MAX_RESUME_TITLE);
}

// 只接受白名单字段：请求体里塞什么就存什么，等于把存储结构交给访客控制。
function pickResume(input) {
  const source = input && typeof input === "object" ? input : {};
  const text = String(source.text ?? "").trim();
  if (!text) throw new HttpError(400, "简历内容不能为空", "bad_request");
  if (text.length > MAX_RESUME_TEXT) {
    throw new HttpError(413, `简历最多 ${MAX_RESUME_TEXT} 字，请精简后重试`, "resume_too_long");
  }
  const jd = String(source.jd ?? "").trim();
  if (jd.length > MAX_JD_TEXT) {
    throw new HttpError(413, `岗位描述最多 ${MAX_JD_TEXT} 字，请精简后重试`, "jd_too_long");
  }
  let analysis = null;
  if (source.analysis && typeof source.analysis === "object") {
    // 分析结果来自模型/本地规则，体积不受控，超限就只留简历正文，避免拖垮存储。
    const serialized = JSON.stringify(source.analysis);
    analysis = serialized.length <= MAX_ANALYSIS_JSON ? source.analysis : null;
  }
  return {
    id: String(source.id || "").slice(0, 64),
    title: String(source.title || "").trim().slice(0, MAX_RESUME_TITLE) || firstLine(text) || "未命名简历",
    role: String(source.role || "").trim().slice(0, 60),
    direction: String(source.direction || "").trim().slice(0, 60),
    text,
    jd,
    analysis
  };
}

export function createAccountHandlers({ store } = {}) {
  const db = store || getStore();
  const authLimiter = createSlidingWindowLimiter({ windowMs: 60_000, max: AUTH_REQUESTS_PER_MINUTE });
  const signupBudget = createDailyBudget({ max: SIGNUPS_PER_DAY });
  // 登录失败按"账号"计数（而不是按 IP）：同一出口 IP 下的其他人不该被牵连，
  // 而被爆破的那个账号无论从哪个 IP 来都该被按住。
  const loginFailures = createSlidingWindowLimiter({ windowMs: 15 * 60_000, max: LOGIN_FAILURES_PER_WINDOW });

  function throttle(req, message) {
    const limit = authLimiter.take(clientKey(req));
    if (!limit.ok) throw new HttpError(429, message, "rate_limited");
  }

  function requireUser(req) {
    const token = readAuthToken(req);
    if (!token) throw new HttpError(401, "请先登录", "unauthenticated");
    const tokenHash = hashToken(token);
    const session = db.sessions.byTokenHash(tokenHash);
    if (!session) throw new HttpError(401, "登录状态已过期，请重新登录", "session_expired");
    const user = db.users.byId(session.userId);
    if (!user) throw new HttpError(401, "账号不存在，请重新登录", "unauthenticated");
    db.sessions.touch(tokenHash, { ttlMs: SESSION_TTL_MS });
    return { user, session, tokenHash };
  }

  function issueSession(user, req) {
    const { token, tokenHash } = createSessionToken();
    const createdAt = Date.now();
    const expiresAt = createdAt + SESSION_TTL_MS;
    db.sessions.create({
      userId: user.id,
      tokenHash,
      createdAt,
      expiresAt,
      agent: String(req?.headers?.["user-agent"] || "").slice(0, 160)
    });
    return { token, expiresAt };
  }

  async function handleRegister(req, res) {
    try {
      if (!ALLOW_SIGNUP) {
        throw new HttpError(403, "本站当前未开放注册，请联系部署方开通账号。", "signup_disabled");
      }
      throttle(req, "注册请求过于频繁，请稍后再试。");
      const body = await readJsonBody(req, 64 * 1024);
      const checked = validateAccount(body.account);
      if (!checked.ok) throw new HttpError(400, checked.error, "invalid_account");
      const password = validatePassword(body.password);
      if (!password.ok) throw new HttpError(400, password.error, "weak_password");
      if (SIGNUP_INVITE_CODE && String(body.inviteCode || "").trim() !== SIGNUP_INVITE_CODE) {
        throw new HttpError(403, "邀请码不正确。", "invite_required");
      }
      if (db.users.byAccount(checked.account)) {
        throw new HttpError(409, "该账号已注册，请直接登录。", "account_exists");
      }
      const budget = signupBudget.take();
      if (!budget.ok) {
        throw new HttpError(429, "今日注册名额已用完，请明天再试。", "signup_quota_exceeded");
      }
      const user = db.users.create({
        account: checked.account,
        passwordHash: hashPassword(body.password),
        createdAt: Date.now()
      });
      if (!user) throw new HttpError(503, "站点体验账号已达上限，请联系部署方。", "user_limit_reached");
      const session = issueSession(user, req);
      sendJson(res, 200, { ...session, user: publicUser(user) });
    } catch (err) {
      fail(res, err, 400, "register_failed");
    }
  }

  async function handleLogin(req, res) {
    try {
      throttle(req, "登录请求过于频繁，请稍后再试。");
      const body = await readJsonBody(req, 64 * 1024);
      const account = normalizeAccount(body.account);
      if (!account) throw new HttpError(400, "请输入账号（邮箱或用户名）", "invalid_account");
      const blocked = loginFailures.check(account);
      if (!blocked.ok) {
        throw new HttpError(429, "密码错误次数过多，请 15 分钟后再试。", "too_many_attempts");
      }
      const user = db.users.byAccount(account);
      const ok = user ? verifyPassword(body.password, user.passwordHash) : false;
      if (!ok) {
        loginFailures.take(account);
        // 统一提示，不区分"账号不存在"和"密码错误"，避免账号枚举。
        throw new HttpError(401, "账号或密码不正确。", "invalid_credentials");
      }
      loginFailures.clear(account);
      const session = issueSession(user, req);
      sendJson(res, 200, { ...session, user: publicUser(user) });
    } catch (err) {
      fail(res, err, 400, "login_failed");
    }
  }

  async function handleLogout(req, res) {
    try {
      const token = readAuthToken(req);
      // 退出登录必须幂等：token 过期/被删时前端也要能干净地退到登录页。
      if (token) db.sessions.remove(hashToken(token));
      sendJson(res, 200, { ok: true });
    } catch (err) {
      fail(res, err, 400, "logout_failed");
    }
  }

  async function handleMe(req, res) {
    try {
      const { user, session } = requireUser(req);
      sendJson(res, 200, { user: publicUser(user), expiresAt: session.expiresAt });
    } catch (err) {
      fail(res, err, 401, "unauthenticated");
    }
  }

  async function handleResumes(req, res) {
    try {
      const { user } = requireUser(req);
      if (String(req.method || "POST").toUpperCase() === "GET") {
        sendJson(res, 200, { resumes: db.resumes.list(user.id) });
        return;
      }
      const body = await readJsonBody(req, 512 * 1024);
      const resume = db.resumes.upsert(user.id, pickResume(body.resume));
      if (!resume) {
        throw new HttpError(429, "简历数量已达上限，请先删除旧简历。", "resume_limit_reached");
      }
      sendJson(res, 200, { resume });
    } catch (err) {
      fail(res, err, 400, "resume_failed");
    }
  }

  async function handleResumeDelete(req, res) {
    try {
      const { user } = requireUser(req);
      const body = await readJsonBody(req, 64 * 1024);
      const id = String(body.id || "");
      if (!id) throw new HttpError(400, "缺少简历 id", "bad_request");
      // 删不到就回 404（而不是静默成功）：越权删除与"本来就没了"必须能区分。
      const removed = db.resumes.remove(user.id, id);
      if (!removed) throw new HttpError(404, "简历不存在或不属于当前账号。", "resume_not_found");
      sendJson(res, 200, { ok: true });
    } catch (err) {
      fail(res, err, 400, "resume_delete_failed");
    }
  }

  async function handleExport(req, res) {
    try {
      const { user } = requireUser(req);
      // 合规要求"能带走自己的数据"：导出的是账号信息与自己名下的简历，不含任何他人数据。
      sendJson(res, 200, {
        exportedAt: new Date().toISOString(),
        user: publicUser(user),
        resumes: db.resumes.list(user.id)
      });
    } catch (err) {
      fail(res, err, 401, "export_failed");
    }
  }

  async function handleAccountDelete(req, res) {
    try {
      const { user } = requireUser(req);
      const body = await readJsonBody(req, 64 * 1024);
      // 注销必须二次验证密码：否则 token 被偷就等于账号被直接删掉。
      if (!verifyPassword(body.password, user.passwordHash)) {
        throw new HttpError(403, "密码不正确，无法注销账号。", "invalid_credentials");
      }
      db.users.remove(user.id);
      sendJson(res, 200, { ok: true });
    } catch (err) {
      fail(res, err, 400, "account_delete_failed");
    }
  }

  return {
    "/api/auth/register": handleRegister,
    "/api/auth/login": handleLogin,
    "/api/auth/logout": handleLogout,
    "/api/auth/me": handleMe,
    "/api/resumes": handleResumes,
    "/api/resumes/delete": handleResumeDelete,
    "/api/account/export": handleExport,
    "/api/account/delete": handleAccountDelete
  };
}
