import { readdirSync, readFileSync } from "node:fs";
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
    // 本机的 data/ 里可能有访客简历与口令哈希，绝不能烤进公开镜像
    expect(ignored).toContain("data");
  });

  it("服务端默认监听 0.0.0.0:7860 并提供 dist 静态资源", () => {
    const server = read("server/index.mjs");
    expect(server).toMatch(/process\.env\.PORT \|\| 7860/);
    expect(server).toMatch(/process\.env\.HOST \|\| "0\.0\.0\.0"/);
    expect(server).toContain("dist");
  });

  it("账号数据目录既不会进仓库，也不会被打包进镜像", () => {
    expect(read(".gitignore")).toMatch(/^data$/m);
    const server = read("server/store.mjs");
    expect(server).toMatch(/path\.join\(projectRoot, "data"\)/);
    expect(server).toMatch(/process\.env\.DATA_DIR/);
    expect(server).toMatch(/process\.env\.STORE_FILE/);
  });
});

// 文档与 .env.example 是给部署方看的"合同"，最容易在功能迭代后腐化。
// 这组断言不管文案好坏，只钉住两件事：文档里写的变量真的被代码读取，
// 以及已经被功能替换掉的说法不会悄悄回来。
describe("部署文档与环境变量样例不腐化", () => {
  const envExample = read(".env.example");
  const deployDoc = read("docs/deploy-modelscope.md");
  const readme = read("README.md");
  const serverSource = readdirSync(path.join(process.cwd(), "server"))
    .filter((name) => name.endsWith(".mjs"))
    .map((name) => read(path.join("server", name)))
    .join("\n");
  const namesMatching = (text, pattern) => [...text.matchAll(pattern)].map((match) => match[1]);

  it("写进 .env.example 的每个变量都真的被服务端读取", () => {
    const names = namesMatching(envExample, /^#?\s*([A-Z][A-Z0-9_]{2,})=/gm);
    expect(names.length).toBeGreaterThan(15);
    for (const name of names) {
      expect(serverSource, `.env.example 里的 ${name} 没有任何服务端代码读取`).toContain(name);
    }
  });

  it("部署文档环境变量表里的变量同样被服务端读取", () => {
    const names = namesMatching(deployDoc, /^\| `([A-Z][A-Z0-9_]+)` \|/gm);
    expect(names.length).toBeGreaterThan(10);
    for (const name of names) {
      expect(serverSource, `部署文档表格里的 ${name} 没有任何服务端代码读取`).toContain(name);
    }
  });

  it("账号相关变量同时出现在 .env.example 与部署文档里", () => {
    for (const name of [
      "ALLOW_SIGNUP",
      "SIGNUP_INVITE_CODE",
      "SESSION_TTL_DAYS",
      "AUTH_REQUESTS_PER_MINUTE",
      "SIGNUPS_PER_DAY",
      "LOGIN_FAILURES_PER_15MIN",
      "DATA_DIR",
      "STORE_FILE"
    ]) {
      expect(envExample, `.env.example 缺 ${name}`).toContain(name);
      expect(deployDoc, `部署文档缺 ${name}`).toContain(name);
    }
  });

  it("不再出现「演示鉴权」这类已经不成立的说法", () => {
    for (const text of [deployDoc, readme]) {
      expect(text).not.toContain("演示鉴权");
      expect(text).not.toContain("不做真实账号校验");
      expect(text).not.toContain("也不存在服务端账号体系");
      expect(text).not.toContain("服务端不存任何账号数据");
    }
  });

  it("部署文档里的 [store] 启动日志文案与服务端实际输出一致", () => {
    const server = read("server/index.mjs");
    for (const phrase of ["持久化已启用", "持久化不可用（容器重启后账号与简历会丢失）"]) {
      expect(server, `server/index.mjs 不再输出「${phrase}」`).toContain(phrase);
      expect(deployDoc, `部署文档没有跟上「${phrase}」这个日志文案`).toContain(phrase);
    }
  });

  // 创空间很可能没有持久卷。这种情况必须给部署方一段现成的兜底话术，
  // 否则要么悄悄对访客承诺"账号长期保存"，要么把丢数据说成程序 bug。
  it("没有持久卷时的兜底话术在文档里，且指明了导出与注销出口", () => {
    const from = deployDoc.indexOf("平台确实没有持久卷时");
    const to = deployDoc.indexOf("## 5. 部署后自检");
    expect(from, "部署文档缺少「平台确实没有持久卷时」这一节").toBeGreaterThan(-1);
    const block = deployDoc.slice(from, to);
    expect(block).toContain("账号只在当次容器生命周期内有效");
    expect(block).toContain("导出账号数据");
    expect(block).toContain("注销账号");
    // 话术只写给部署方看还不够，落地检查表里也要有对应项
    expect(deployDoc).toContain("可直接粘「平台确实没有持久卷时」那段现成文案");
  });

  // 创空间默认模板是 Gradio/Streamlit，选错 SDK 会去找 app.py，
  // 本项目靠根目录 Dockerfile 启动，所以这条必须写在文档最显眼的位置。
  it("部署文档把「SDK 必须选 Docker」写清楚了", () => {
    expect(deployDoc).toMatch(/类型选 \*\*Docker\*\*/);
    expect(deployDoc).toContain("不要选 Gradio / Streamlit");
    expect(deployDoc).toContain("SdkType");
    // 仓库根目录必须有 Dockerfile，否则 Docker 类型也无从启动
    expect(read("Dockerfile")).toMatch(/EXPOSE\s+7860/);
  });

  it("文档写的 E2E 断言条数不落后于脚本（加用例就得改文档）", () => {
    const stated = Number(/跑 (\d+) 条断言/.exec(deployDoc)?.[1] || 0);
    const inScript = (read("scripts/e2e/interview.e2e.cjs").match(/check\(/g) || []).length;
    expect(stated, "部署文档没有写明 E2E 断言条数").toBeGreaterThan(0);
    expect(inScript, "e2e 脚本里一处 check( 都没有，断言解析可能失效").toBeGreaterThan(20);
    expect(stated, `文档写 ${stated} 条，但脚本里已有 ${inScript} 处 check(`).toBeGreaterThanOrEqual(inScript);
  });
});
