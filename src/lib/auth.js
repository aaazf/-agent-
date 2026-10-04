// 账号相关的浏览器端封装：登录态存取 + 认证接口调用。
//
// token 存在 localStorage 而不是 Cookie：创空间是把本站内嵌在 modelscope.cn
// 页面里的 iframe，第三方上下文里的 Cookie 会被浏览器直接拦掉，登录态会时有时无。
// 代价是"XSS 能偷走 token"，对应的防线是：CSP 只允许 self 脚本 + 全站不使用
// dangerouslySetInnerHTML（渲染模型输出也走 React 转义）。
const TOKEN_KEY = "face-interview-auth-token-v1";

export class ApiError extends Error {
  constructor(message, { status = 0, code = "" } = {}) {
    super(message || "请求失败");
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }

  get offline() {
    return this.status === 0;
  }
}

export function loadToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

export function saveToken(token) {
  try {
    localStorage.setItem(TOKEN_KEY, String(token || ""));
  } catch {
    // 写不进去（隐私模式）时只是"刷新后要重新登录"，不影响本次使用
  }
}

export function clearToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // 忽略
  }
}

export function authHeaders(extra = {}) {
  const token = loadToken();
  return token ? { ...extra, Authorization: `Bearer ${token}` } : { ...extra };
}

// 会话过期时的全局回调：让 App 能把访客请回登录页，而不是让页面停在
// 一堆"请求失败"的错误提示上。
let unauthorizedHandler = null;

export function onUnauthorized(handler) {
  unauthorizedHandler = handler;
  return () => {
    if (unauthorizedHandler === handler) unauthorizedHandler = null;
  };
}

// 统一的 JSON 请求：把 HTTP 状态与后端 code 转成结构化错误，
// 页面只需要判断 err.code / err.offline，不用各自解析响应体。
export async function request(path, { method = "POST", body, auth = true, signal } = {}) {
  const headers = auth ? authHeaders({ "Content-Type": "application/json" }) : { "Content-Type": "application/json" };
  let res;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal
    });
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    throw new ApiError("无法连接服务端，请检查网络后重试。", { status: 0, code: "network_error" });
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    // 401 说明登录态已经失效：先清掉本机 token，再通知上层回登录页。
    // 登录/注册接口用 auth=false 调用，所以"密码错误"不会被误判成会话过期。
    if (res.status === 401 && auth) {
      clearToken();
      const code = data?.code || "unauthenticated";
      if (unauthorizedHandler) unauthorizedHandler(code);
    }
    throw new ApiError(data?.error || `请求失败（${res.status}）`, { status: res.status, code: data?.code || "" });
  }
  return data || {};
}

export function registerAccount({ account, password, inviteCode }) {
  return request("/api/auth/register", { body: { account, password, inviteCode }, auth: false });
}

export function loginAccount({ account, password }) {
  return request("/api/auth/login", { body: { account, password }, auth: false });
}

// 退出登录要幂等：服务端删不掉（离线/已过期）也必须能干净地退回登录页，
// 所以这里吞掉错误，只保证本地 token 一定清掉。
export async function logoutAccount() {
  try {
    await request("/api/auth/logout", { body: {} });
  } catch {
    // 忽略
  }
  clearToken();
}

// 启动时恢复登录态，必须区分三件事：
//   anonymous = 确实没登录（或 token 已失效，本地已清掉）
//   authenticated = 有有效会话
//   offline = 服务端连不上（不能把这种情况当成"未登录"直接把用户踢回去）
export async function restoreSession() {
  if (!loadToken()) return { status: "anonymous" };
  try {
    const data = await request("/api/auth/me", { method: "GET" });
    return { status: "authenticated", user: data.user };
  } catch (err) {
    if (err instanceof ApiError && !err.offline) {
      clearToken();
      return { status: "anonymous" };
    }
    return { status: "offline", error: err.message };
  }
}
