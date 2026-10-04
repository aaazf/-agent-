import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { API_ROUTE_METHODS, createApiHandlers, warmup } from "./server/api.mjs";
import { loadDotEnv } from "./server/env.mjs";

loadDotEnv();

// 开发/预览期把同一套接口挂到 Vite 中间件上；生产环境由 server/index.mjs 提供。
function apiPlugin() {
  const routes = createApiHandlers();
  const mount = (server) => {
    for (const [pathname, handler] of Object.entries(routes)) {
      // 与生产服务器保持同一套方法约定，避免"开发环境能 GET、上线 405"的假象。
      const allowed = API_ROUTE_METHODS[pathname] || ["POST"];
      server.middlewares.use(pathname, (req, res, next) => {
        if (!allowed.includes(String(req.method || "").toUpperCase())) {
          res.statusCode = 405;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ error: `仅支持 ${allowed.join(" / ")}`, code: "method_not_allowed" }));
          return;
        }
        Promise.resolve(handler(req, res)).catch(next);
      });
    }
  };
  return {
    name: "local-api-proxy",
    configureServer(server) {
      warmup();
      mount(server);
    },
    configurePreviewServer(server) {
      warmup();
      mount(server);
    }
  };
}

export default defineConfig({
  plugins: [react(), apiPlugin()],
  server: {
    host: process.env.HOST || "127.0.0.1",
    port: Number(process.env.PORT || 4173),
    strictPort: false
  },
  preview: {
    host: process.env.HOST || "127.0.0.1",
    port: Number(process.env.PORT || 4173)
  },
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.js"]
  }
});
