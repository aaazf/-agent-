import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (relative) => readFileSync(path.join(process.cwd(), relative), "utf8");

// 本地没有 Docker（也没有可用的 WSL 发行版），镜像构建无法在这里真跑一遍。
// 退而求其次：把"创空间能不能跑起来"依赖的几处约定钉成断言，
// 让改坏 Dockerfile / .dockerignore / 启动脚本时在单元测试阶段就报错。
describe("容器部署一致性（创空间：Docker + 7860）", () => {
  const dockerfile = read("Dockerfile");
  const dockerignore = read(".dockerignore");
  const pkg = JSON.parse(read("package.json"));

  it("暴露 7860 并按 0.0.0.0 监听", () => {
    expect(dockerfile).toMatch(/EXPOSE\s+7860/);
    expect(dockerfile).toMatch(/PORT=7860/);
    expect(dockerfile).toMatch(/HOST=0\.0\.0\.0/);
  });

  it("先构建前端产物再启动服务，否则页面 404", () => {
    expect(dockerfile).toMatch(/npm run build/);
    expect(dockerfile.trimEnd().endsWith('CMD ["npm", "start"]')).toBe(true);
    expect(pkg.scripts.build).toBeTruthy();
    expect(pkg.scripts.start).toBe("node server/index.mjs");
  });

  it("生产依赖与构建依赖都装得上（构建需要 vite）", () => {
    expect(dockerfile).toMatch(/npm ci/);
    expect(dockerfile).not.toMatch(/--omit=dev|--production\b/);
    expect(pkg.devDependencies.vite).toBeTruthy();
  });

  it(".dockerignore 不能排掉构建与服务运行时需要的目录", () => {
    const ignored = dockerignore
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    for (const needed of ["src", "server", "public", "scripts", "index.html", "vite.config.js", "package.json", "package-lock.json"]) {
      expect(ignored, `.dockerignore 排掉了 ${needed}`).not.toContain(needed);
    }
    // 该排的仍要排，否则镜像会把本机 node_modules 带进去
    expect(ignored).toContain("node_modules");
    expect(ignored).toContain("dist");
  });

  it("服务端默认监听 0.0.0.0:7860 并提供 dist 静态资源", () => {
    const server = read("server/index.mjs");
    expect(server).toMatch(/process\.env\.PORT \|\| 7860/);
    expect(server).toMatch(/process\.env\.HOST \|\| "0\.0\.0\.0"/);
    expect(server).toContain("dist");
  });
});
