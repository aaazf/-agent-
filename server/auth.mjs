// 认证原语：账号/口令校验、口令哈希、会话 token。
// 只用 node 内置的 crypto，不引入 bcrypt/argon2 这类需要编译的依赖
// （容器基座是 node:20-slim，编译失败等于整个部署失败）。
//
// 口令用 scrypt（N=16384, r=8, p=1，单次约 60ms）：比 PBKDF2 更抗 GPU 爆破，
// 又不像 argon2 那样必须装原生模块。存储格式自带参数，将来调参也不影响老用户登录：
//   scrypt$N$r$p$<salt-base64url>$<key-base64url>
import crypto from "node:crypto";

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;
export const SESSION_TOKEN_BYTES = 32;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[a-z0-9][a-z0-9_.-]{2,31}$/;

// 账号可以是邮箱，也可以是用户名：社区体验站里逼访客留邮箱会显著劝退，
// 但两者都要能唯一标识一个账号，所以统一小写归一化后再比。
export function normalizeAccount(raw) {
  return String(raw ?? "").trim().toLowerCase();
}

export function validateAccount(raw) {
  const account = normalizeAccount(raw);
  if (!account) return { ok: false, error: "请输入账号（邮箱或用户名）" };
  if (account.length > 254) return { ok: false, error: "账号过长" };
  if (account.includes("@")) {
    if (!EMAIL_RE.test(account)) return { ok: false, error: "邮箱格式不正确" };
    return { ok: true, account };
  }
  if (!USERNAME_RE.test(account)) {
    return { ok: false, error: "用户名需 3-32 位，只能用字母、数字、下划线、点或短横线，且以字母或数字开头" };
  }
  return { ok: true, account };
}

export function validatePassword(password) {
  const value = String(password ?? "");
  if (value.length < PASSWORD_MIN_LENGTH) return { ok: false, error: `密码至少 ${PASSWORD_MIN_LENGTH} 位` };
  if (value.length > PASSWORD_MAX_LENGTH) return { ok: false, error: `密码最多 ${PASSWORD_MAX_LENGTH} 位` };
  if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) {
    return { ok: false, error: "密码需要同时包含字母和数字" };
  }
  return { ok: true };
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(password), salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p
  });
  return [
    "scrypt",
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString("base64url"),
    key.toString("base64url")
  ].join("$");
}

// 恒定时间比较：不要用 === 比哈希，那会泄漏"前几位对上了"的时序信息。
export function verifyPassword(password, stored) {
  try {
    const parts = String(stored || "").split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const [, n, r, p, salt, key] = parts;
    const expected = Buffer.from(key, "base64url");
    const actual = crypto.scryptSync(String(password), Buffer.from(salt, "base64url"), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p)
    });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    // 存储值被改坏时一律当作验证失败，不要把异常抛到路由层变成 500。
    return false;
  }
}

// 会话 token 只把哈希落盘：数据文件泄漏时，攻击者也无法拿它冒充登录态。
export function createSessionToken() {
  const token = crypto.randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
  return { token, tokenHash: hashToken(token) };
}

export function hashToken(token) {
  return crypto.createHash("sha256").update(String(token || ""), "utf8").digest("base64url");
}

// 登录态用什么承载：这里踩过一次线上故障，值得写下来。
//   最初用 `Authorization: Bearer <token>`。在 ModelScope 创空间上，平台的边缘网关会把
//   带 Authorization 头的请求直接回 403（实测：同一个请求去掉这个头就正常转发到应用），
//   表现为"登录成功 → 进下一屏时第一次受保护请求 403 → 前端判定登录态失效 → 弹回登录页"。
//   实测：自定义头 / Cookie / 查询参数都能穿过网关，只有 Authorization 不行。
// 所以现在的规则是：主通道 `X-Auth-Token`，`Authorization: Bearer` 仅作兼容保留
//   （自建服务器、脚本/curl 调用时仍可用）。两者浏览器都不会自动携带，跨站也带不上
//   （自定义头会触发 CORS 预检），因此不存在 CSRF 面。
// 不用 Cookie 的原因照旧：创空间把本站内嵌在 modelscope.cn 页面里，
//   第三方上下文的 Cookie 会被浏览器直接拦掉，登录态会时有时无。
export const AUTH_TOKEN_HEADER = "x-auth-token";

// 头名大小写不敏感（Node 收到的请求头一律小写，但测试/代理可能给别的写法）。
function headerValue(headers, name) {
  if (!headers || typeof headers !== "object") return "";
  const direct = headers[name];
  if (direct !== undefined) return String(direct);
  const key = Object.keys(headers).find((item) => item.toLowerCase() === name);
  return key ? String(headers[key]) : "";
}

export function readAuthToken(req) {
  const headers = req?.headers;
  const custom = headerValue(headers, AUTH_TOKEN_HEADER).trim();
  if (custom) return custom;
  const header = headerValue(headers, "authorization");
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : "";
}
