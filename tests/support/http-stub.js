// 路由级测试共用的 HTTP 桩：把 Node 的 req/res 简化成 handler 真正用到的形状。
// （文件名不叫 *.test.js，所以不会被 vitest 当作用例收集。）
import { EventEmitter } from "node:events";

export function createReq(payload, { headers = {}, method = "POST", url = "/api/llm" } = {}) {
  const raw = typeof payload === "string" ? payload : JSON.stringify(payload ?? {});
  const body = Buffer.from(raw, "utf8");
  return {
    method,
    url,
    headers,
    socket: { remoteAddress: "10.0.0.9" },
    [Symbol.asyncIterator]() {
      let sent = false;
      return {
        next() {
          if (sent) return Promise.resolve({ done: true, value: undefined });
          sent = true;
          return Promise.resolve({ done: false, value: body });
        }
      };
    }
  };
}

export function createRes() {
  const emitter = new EventEmitter();
  const res = {
    statusCode: 200,
    headers: {},
    body: "",
    writableEnded: false,
    destroyed: false,
    setHeader(name, value) {
      res.headers[name.toLowerCase()] = value;
    },
    writeHead(statusCode, headers) {
      res.statusCode = statusCode;
      Object.entries(headers || {}).forEach(([name, value]) => res.setHeader(name, value));
      return res;
    },
    end(chunk) {
      if (chunk !== undefined) res.body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      res.writableEnded = true;
    },
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    emit: emitter.emit.bind(emitter)
  };
  return res;
}

export function parseJson(res) {
  try {
    return JSON.parse(res.body);
  } catch {
    return null;
  }
}

// 调用一次路由并返回 { res, json, status }。routes 由调用方持有，
// 这样限流器之类的有状态对象可以在同一组用例里连续生效。
export async function callRoute(routes, path, payload, options = {}) {
  const handler = routes[path];
  if (!handler) throw new Error(`路由不存在：${path}`);
  const req = createReq(payload, { url: path, ...options });
  const res = createRes();
  await handler(req, res);
  return { res, json: parseJson(res), status: res.statusCode };
}

// 带登录态的调用：把 token 放进 Authorization 头。
export function withToken(token, options = {}) {
  return {
    ...options,
    headers: { ...(options.headers || {}), authorization: `Bearer ${token}` }
  };
}
