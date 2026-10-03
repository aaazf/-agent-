// 独立生产服务器：托管 dist/ 静态资源 + /api/* 接口。
// 用于容器部署（ModelScope 创空间要求 0.0.0.0 + 7860），不依赖 Vite。
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { loadDotEnv, projectRoot } from "./env.mjs";
import { createApiHandlers, warmup } from "./api.mjs";

loadDotEnv();

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 7860);
const DIST_DIR = path.resolve(process.env.DIST_DIR || path.join(projectRoot, "dist"));
const INDEX_FILE = path.join(DIST_DIR, "index.html");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".mp3": "audio/mpeg",
  ".txt": "text/plain; charset=utf-8"
};

// frame-ancestors 放开是为了能被创空间页面内嵌；其余按最小权限收敛。
// 注意：`*` 只匹配 http/https 这类网络来源，不匹配 about:blank / data: 等不透明来源，
// 所以不建议在透明包装页里做嵌入测试。如需收紧到固定站点，设置 ALLOWED_FRAME_ANCESTORS="https://modelscope.cn"。
const FRAME_ANCESTORS = process.env.ALLOWED_FRAME_ANCESTORS || "*";
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "font-src 'self' data:",
  "base-uri 'self'",
  "form-action 'self'",
  `frame-ancestors ${FRAME_ANCESTORS}`
].join("; ");

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Content-Security-Policy": CSP
};

const routes = createApiHandlers();

function send(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

function resolveStaticPath(urlPath) {
  const decoded = decodeURIComponent(urlPath);
  const target = path.resolve(DIST_DIR, `.${path.posix.normalize(decoded)}`);
  // 目录穿越防护：解析结果必须仍在 dist 内。
  if (target !== DIST_DIR && !target.startsWith(DIST_DIR + path.sep)) return null;
  return target;
}

function serveFile(req, res, filePath, { statusCode = 200, cache = "public, max-age=31536000, immutable" } = {}) {
  const ext = path.extname(filePath).toLowerCase();
  const headers = { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" };
  // 带 hash 的产物可长缓存，index.html 必须每次校验，否则更新后访客拿到旧壳。
  headers["Cache-Control"] = ext === ".html" ? "no-cache" : cache;
  res.writeHead(statusCode, { ...SECURITY_HEADERS, ...headers });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  const stream = fs.createReadStream(filePath);
  stream.on("error", () => {
    if (!res.writableEnded) res.end();
  });
  stream.pipe(res);
}

async function handleRequest(req, res) {
  const urlPath = (req.url || "/").split("?")[0];

  // 所有响应（含 API 与错误页）统一带上安全头，避免逐个分支漏配。
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);

  if (urlPath.startsWith("/api/")) {
    const handler = routes[urlPath];
    if (!handler) {
      send(res, 404, JSON.stringify({ error: "接口不存在" }), { "Content-Type": "application/json; charset=utf-8" });
      return;
    }
    if (req.method !== "POST") {
      send(res, 405, JSON.stringify({ error: "仅支持 POST" }), { "Content-Type": "application/json; charset=utf-8" });
      return;
    }
    await handler(req, res);
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    send(res, 405, "Method Not Allowed", { "Content-Type": "text/plain; charset=utf-8" });
    return;
  }

  if (!fs.existsSync(INDEX_FILE)) {
    send(res, 503, "构建产物缺失：请先执行 npm run build（或在容器内由 Dockerfile 完成构建）。", {
      "Content-Type": "text/plain; charset=utf-8"
    });
    return;
  }

  const target = resolveStaticPath(urlPath);
  if (target && fs.existsSync(target) && fs.statSync(target).isFile()) {
    serveFile(req, res, target);
    return;
  }

  // SPA 回退：前端路由交给 index.html。
  serveFile(req, res, INDEX_FILE, { cache: "no-cache" });
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    if (!res.writableEnded) {
      send(res, 500, JSON.stringify({ error: err?.message || String(err) }), {
        "Content-Type": "application/json; charset=utf-8"
      });
    }
  });
});

server.listen(PORT, HOST, () => {
  warmup();
  console.log(`[interview-agent] listening on http://${HOST}:${PORT} (dist=${DIST_DIR})`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
