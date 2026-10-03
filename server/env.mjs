// 轻量 .env 载入：优先用 Node 内置能力，缺失时静默跳过（不引入额外依赖）。
// 用途：本地/容器里通过 .env 指定 EDGE_TTS_PYTHON、HOSTED_LLM_TOKEN 等，避免把密钥写进代码。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let loaded = false;

export function loadDotEnv() {
  if (loaded) return;
  loaded = true;
  const envPath = path.join(projectRoot, ".env");
  if (!fs.existsSync(envPath)) return;
  if (typeof process.loadEnvFile === "function") {
    try {
      process.loadEnvFile(envPath);
    } catch {
      // .env 格式异常时忽略，继续用进程环境变量
    }
  }
}