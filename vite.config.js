import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createApiHandlers, warmup } from "./server/api.mjs";
import { loadDotEnv } from "./server/env.mjs";

loadDotEnv();

// 开发/预览期把同一套接口挂到 Vite 中间件上；生产环境由 server/index.mjs 提供。
function apiPlugin() {
  const routes = createApiHandlers();
  const mount = (server) => {
    for (const [pathname, handler] of Object.entries(routes)) {
      server.middlewares.use(pathname, handler);
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