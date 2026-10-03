// 真实浏览器端到端验证（不属于 npm test，需要本机已装 Chrome 与 puppeteer）。
//
// 默认由脚本自己拉起「桩 ASR 上游 + 应用服务器」，所以不需要手动 npm start；
// 想验证已部署环境时设置 E2E_BASE=https://... 即可跳过托管。
// 需要先 npm run build（脚本只跑已构建产物）。
//
// 覆盖：
//   A. 顶层窗口：无 JS 报错 / 无 CSP 拦截 / 伪麦克风 getUserMedia / SpeechRecognition 真实启动 / 文字面试逐题推进
//   B. 真实 http 宿主页内嵌且父页未授权：出现内嵌提示、麦克风被拒、文字面试仍完整可用
//   C. 宿主页带 allow="microphone; camera"：内嵌窗口也能拿到麦克风并启动语音识别
//   D. 服务端语音识别全链路：真实录音 -> /api/asr -> 上游 multipart -> 转写文字 -> 面试推进到下一题
//
// 用法：
//   npm run build && npm run e2e
//   Windows: $env:NODE_PATH = (npm root -g); npm run e2e
// 可选环境变量：E2E_BASE、CHROME_PATH、E2E_APP_PORT、E2E_ASR_PORT、E2E_HOST_PORT、SKIP_A=1
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");
const puppeteer = require("puppeteer");

function resolveChromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  ].filter(Boolean);
  const found = candidates.find((item) => fs.existsSync(item));
  if (!found) throw new Error("未找到 Chrome，请用 CHROME_PATH 指定可执行文件路径");
  return found;
}

const TRANSCRIPT = "我在上一家公司负责电商中台的前端架构，把首屏加载从三秒降到了不到两秒";
const CHROME = resolveChromePath();
const ASR_PORT = Number(process.env.E2E_ASR_PORT || 7911);
const APP_PORT = Number(process.env.E2E_APP_PORT || 7862);
const HOST_PORT = Number(process.env.E2E_HOST_PORT || 7900);
const HOSTED_PORT = Number(process.env.E2E_HOSTED_PORT || 7863);
const MANAGE_SERVER = !process.env.E2E_BASE;
const BASE = process.env.E2E_BASE || `http://127.0.0.1:${APP_PORT}`;
const SKIP_A = process.env.SKIP_A === "1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fakeAudioPath = "";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail: String(detail) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "   [" + String(detail) + "]" : ""}`);
}

// 伪麦克风的音源：一段 44.1kHz 单声道正弦波，够 MediaRecorder 录到真实字节。
function ensureFakeAudio() {
  const file = path.join(process.env.TEMP || process.env.TMPDIR || "/tmp", "ia-fake-audio.wav");
  if (fs.existsSync(file) && fs.statSync(file).size > 1000) return file;
  const sampleRate = 44100;
  const seconds = 4;
  const total = sampleRate * seconds;
  const data = Buffer.alloc(total * 2);
  for (let i = 0; i < total; i += 1) {
    const value = Math.sin((2 * Math.PI * 180 * i) / sampleRate) * 0.3 * 32767;
    data.writeInt16LE(Math.round(value), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, data]));
  return file;
}

// 桩 ASR 上游：记录收到的 multipart，返回固定转写文字。
const MODEL_QUESTION = "请说说你在电商中台里做过最难的一次性能优化，当时是怎么定位的？";
const MODEL_REPLY = "嗯，我先记一下你的项目背景。";
const HOSTED_MODEL = "stub-hosted-model";
const HOSTED_TOKEN = "stub-hosted-token";

// 桩上游同时扮演 ASR 与 OpenAI 兼容的 LLM：按提示词里的特征串区分"简历结构化 /
// 整场评分 / 出题追问"三类请求，各自返回合法 JSON，并把请求体留档，
// 供断言"访客到底有没有真的走模型"。
function startStubUpstream() {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const isChat = String(req.url || "").includes("chat/completions");
      const text = isChat ? body.toString("utf8") : "";
      received.push({
        url: req.url,
        auth: req.headers.authorization,
        contentType: req.headers["content-type"],
        bytes: body.length,
        body: text
      });
      res.setHeader("Content-Type", "application/json");
      if (!isChat) {
        res.end(JSON.stringify({ text: TRANSCRIPT }));
        return;
      }
      const reply = (payload) =>
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }));
      if (text.includes("简历结构化")) {
        reply({
          name: "张三",
          gender: "男",
          years: "3 年",
          email: "demo@example.com",
          phone: "",
          skills: ["React", "TypeScript"],
          projects: [{ title: "电商运营看板", role: "前端负责人", tech: "React", detail: "首屏从 3.2 秒降到 1.8 秒" }],
          summary: "3 年前端经验"
        });
        return;
      }
      if (text.includes("维度键名固定为")) {
        reply({
          scores: { communication: 82, professional: 84, matching: 80, clarity: 86, composure: 88 },
          overall: 84,
          summary: "整场回答结构清楚。",
          strengths: ["有量化结果"],
          improvements: ["补充权衡过程"],
          actionPlan: ["每道题补一个数字和一个权衡点"],
          perQuestion: [{ score: 84, issues: ["缺少失败复盘"], plan: "补一个失败点" }]
        });
        return;
      }
      reply({
        understanding: { summary: "讲了电商中台性能优化", strength: "有量化", weakness: "缺少定位过程", depth: "中" },
        strategy: { covered: ["项目深挖"], gap: "定位手段", next_focus: "排查路径" },
        decision: "followup",
        reply: MODEL_REPLY,
        question: MODEL_QUESTION
      });
    });
  });
  return new Promise((resolve) => server.listen(ASR_PORT, "127.0.0.1", () => resolve({ server, received })));
}

async function startAppServer({ port = APP_PORT, extraEnv = {} } = {}) {
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server/index.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      ASR_BASE_URL: `http://127.0.0.1:${ASR_PORT}/v1`,
      ASR_MODEL: "stub-asr",
      ASR_TOKEN: "stub-token",
      ...extraEnv
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  for (let i = 0; i < 60; i += 1) {
    await sleep(300);
    try {
      const res = await fetch(`${base}/api/health`, { method: "POST" });
      if (res.ok) return { child, base, health: await res.json() };
    } catch {
      // 还没起来
    }
  }
  throw new Error(`应用服务器未就绪：${output.slice(0, 300)}`);
}

function startHostServer() {
  const server = http.createServer((req, res) => {
    const allow = (req.url || "").startsWith("/allow");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(
      `<html><body style="margin:0;font:14px sans-serif"><h1>宿主页 allow=${allow}</h1>` +
        `<iframe ${allow ? 'allow="microphone; camera"' : ""} src="${BASE}" style="width:1280px;height:800px;border:1px solid #ccc"></iframe>` +
        `</body></html>`
    );
  });
  return new Promise((resolve) => server.listen(HOST_PORT, "127.0.0.1", () => resolve(server)));
}

async function clickByText(target, text) {
  const handle = await target.evaluateHandle((t) => {
    const nodes = Array.from(document.querySelectorAll("button, a"));
    return nodes.find((n) => (n.textContent || "").includes(t)) || null;
  }, text);
  const el = handle.asElement();
  if (!el) throw new Error(`找不到包含「${text}」的按钮`);
  await el.click();
}

async function readBadge(target) {
  return target.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll("div, span, b"));
    const badge = nodes.find((n) => /^第 \d+ 题/.test((n.textContent || "").trim()));
    if (!badge) return null;
    const p = badge.parentElement && badge.parentElement.querySelector("p");
    return { badge: badge.textContent.trim(), text: p ? p.textContent.trim() : "" };
  });
}

async function waitForBadgeChange(target, firstBadge, timeoutMs = 40000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await sleep(1000);
    const badge = await readBadge(target);
    if (badge && !badge.badge.startsWith(firstBadge)) return badge;
  }
  return null;
}

// 等某个题号下出现指定题面。走共享额度时首题要先 await 一次 /api/health 再请求模型，
// 直接读题号会读到"题号已换、题面还没到"的中间态，所以这里必须等题面。
async function waitForBadgeText(target, questionBadge, expected, timeoutMs = 40000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const badge = await readBadge(target);
    if (badge && badge.badge.startsWith(questionBadge) && `${badge.badge} ${badge.text}`.includes(expected)) return badge;
    await sleep(500);
  }
  return null;
}

// 面试总题数由头部进度（进度 N / M）读出，循环不再把题数写死在用例里。
async function readQuestionCount(target) {
  return target.evaluate(() => {
    const match = document.body.innerText.match(/进度\s*\d+\s*\/\s*(\d+)/);
    return match ? Number(match[1]) : 0;
  });
}

// "发送回答"在输入为空时是 disabled 的：先把可点状态等出来，
// 这样一旦失败，报错会指向"文字没输进去"，而不是含糊的超时。
async function waitForEnabledButton(target, label, timeoutMs = 20000) {
  await target.waitForFunction(
    (text) => Array.from(document.querySelectorAll("button")).some((b) => (b.textContent || "").includes(text) && !b.disabled),
    { timeout: timeoutMs, polling: 200 },
    label
  );
}

async function findFrame(host, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const found = host.frames().find((frame) => frame.url().startsWith(BASE));
    if (found) return found;
    await sleep(300);
  }
  throw new Error(`未找到 iframe，当前帧：${host.frames().map((f) => f.url()).join(",")}`);
}

async function probeMic(target) {
  return target.evaluate(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      return "granted";
    } catch (e) {
      return `denied:${e.name}`;
    }
  });
}

// 面试形式会写进 localStorage，所以调用方必须显式指定，避免被上一段用例的残留设置带偏。
async function goToInterview(target, { mode }) {
  const splash = await target.$(".splash-enter");
  if (splash) await splash.click();
  await target.waitForSelector(".login-submit", { timeout: 20000 });
  await target.click(".login-submit");
  await target.waitForFunction(() => document.body.innerText.includes("选择并接入大模型"), { timeout: 20000 });
  await clickByText(target, "暂不接入，本地题库继续");
  await target.waitForFunction(() => document.body.innerText.includes("岗位与简历材料"), { timeout: 20000 });
  await clickByText(target, "下一步：设备与面试类型");
  await target.waitForFunction(() => document.body.innerText.includes("设备检测与面试类型"), { timeout: 20000 });
  await clickByText(target, mode === "text" ? "文字面试" : "面对面语音");
  await clickByText(target, "下一步：进入模拟面试");
}

async function runTextInterview(target, prefix) {
  await goToInterview(target, { mode: "text" });
  await target.waitForSelector("textarea", { timeout: 25000 });
  const first = await readBadge(target);
  check(`${prefix} 文字面试生成第 1 题`, Boolean(first && first.badge.startsWith("第 1 题")), first ? first.badge.slice(0, 14) : "未找到题号");

  await target.click("textarea");
  await target.type("textarea", "我负责过电商中台，用 React + TypeScript 拆分组件库，首屏加载从 3.2 秒降到 1.8 秒。");
  await target.waitForSelector("button.answer-btn", { timeout: 10000 });
  await clickByText(target, "发送回答");
  const advanced = await waitForBadgeChange(target, "第 1 题");
  check(`${prefix} 提交回答后推进到下一题`, Boolean(advanced), advanced ? advanced.badge.slice(0, 14) : "仍停留在第 1 题");
}

async function runVoiceAsrInterview(target, prefix) {
  await goToInterview(target, { mode: "voice" });
  await target.waitForFunction(() => document.body.innerText.includes("面对面实时语音面试"), { timeout: 25000 });
  await target.waitForFunction(() => document.body.innerText.includes("语音识别在服务端完成"), { timeout: 25000 });
  check(`${prefix}1 语音就绪页识别出服务端 ASR`, true);

  await target.evaluate(() => {
    window.__seen = [];
    const observer = new MutationObserver(() => window.__seen.push(document.body.innerText));
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
  });

  // 独立上下文里 localStorage 是空的，所以这里必须走一遍“未确认 → 告知 → 确认”的完整路径。
  const gate = await target.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll("button"));
    const start = buttons.find((b) => (b.textContent || "").includes("点击开始语音面试") || (b.textContent || "").includes("请先确认"));
    const card = document.querySelector(".voice-consent");
    return {
      hasCard: Boolean(card),
      mentionsUpload: Boolean(card && /上传到本站服务器/.test(card.textContent)),
      mentionsSensitive: Boolean(card && /敏感信息/.test(card.textContent)),
      hasTextExit: buttons.some((b) => (b.textContent || "").includes("改用文字面试")),
      startDisabled: start ? start.disabled : null
    };
  });
  check(
    `${prefix}0 录音前出现语音告知且开始按钮被拦截`,
    gate.hasCard && gate.mentionsUpload && gate.mentionsSensitive && gate.startDisabled === true,
    JSON.stringify(gate)
  );
  check(`${prefix}0b 告知卡提供“改用文字面试”出口`, gate.hasTextExit);

  await clickByText(target, "我已知晓，同意上传录音识别");
  await target.waitForFunction(
    () => Array.from(document.querySelectorAll("button")).some((b) => (b.textContent || "").includes("已确认，可以开始")),
    { timeout: 10000 }
  );
  const released = await target.evaluate(() => {
    const start = Array.from(document.querySelectorAll("button")).find((b) => (b.textContent || "").includes("点击开始语音面试"));
    return start ? start.disabled === false : null;
  });
  check(`${prefix}0c 确认后开始按钮解除拦截`, released === true, String(released));

  await clickByText(target, "点击开始语音面试");
  await target.waitForFunction(() => document.body.innerText.includes("正在录音（服务端识别）"), { timeout: 40000 });
  check(`${prefix}2 进入服务端录音状态`, true);

  await sleep(3000);
  await clickByText(target, "我说完了");
  const advanced = await waitForBadgeChange(target, "第 1 题");
  check(`${prefix}3 服务端识别后推进到下一题`, Boolean(advanced), advanced ? advanced.badge.slice(0, 14) : "未推进");

  const seen = await target.evaluate((expected) => (window.__seen || []).some((text) => text.includes(expected)), TRANSCRIPT);
  check(`${prefix}4 页面出现服务端转写文字`, seen, TRANSCRIPT.slice(0, 16));
}

// 共享额度路径：访客不填 Key，也必须真的走模型。这是托管额度存在的全部意义，
// 而此前出题与评分都拿 settings.apiKey 当门槛，这条路整场落到本地题库。
async function runHostedModelInterview(target, prefix, stub) {
  const splash = await target.$(".splash-enter");
  if (splash) await splash.click();
  await target.waitForSelector(".login-submit", { timeout: 20000 });
  await target.click(".login-submit");
  await target.waitForFunction(() => document.body.innerText.includes("选择并接入大模型"), { timeout: 20000 });
  await target.waitForFunction(() => document.body.innerText.includes("共享体验额度"), { timeout: 20000 });
  const ghost = await target.evaluate(() =>
    Array.from(document.querySelectorAll("button")).some((b) => (b.textContent || "").includes("暂不接入"))
  );
  check(`${prefix}1 有共享额度时不再出现“暂不接入”出口`, ghost === false);

  // 留空 API Key，直接点主按钮继续——这正是社区访客的操作路径。
  await clickByText(target, "下一步：面试准备");
  await target.waitForFunction(() => document.body.innerText.includes("岗位与简历材料"), { timeout: 20000 });
  await clickByText(target, "下一步：设备与面试类型");
  await target.waitForFunction(() => document.body.innerText.includes("设备检测与面试类型"), { timeout: 20000 });
  await clickByText(target, "文字面试");
  await clickByText(target, "下一步：进入模拟面试");

  await target.waitForSelector("textarea", { timeout: 25000 });
  const first = await waitForBadgeText(target, "第 1 题", MODEL_QUESTION, 40000);
  const rendered = first ? `${first.badge} ${first.text}` : "";
  check(`${prefix}2 首题真的来自模型，而不是本地题库`, Boolean(first), rendered.trim().slice(0, 42) || "第 1 题始终没有出现模型题面");

  const total = await readQuestionCount(target);
  check(`${prefix}3 面试总题数可从进度读出`, total >= 3, `questionCount=${total}`);
  const rounds = total >= 3 ? total : 6;

  // 页面状态时间线：收尾后到底停在报告页、还是被弹回工作台，靠这条记录定位。
  await target.evaluate(() => {
    window.__timeline = [];
    window.__reloaded = false;
    window.addEventListener("beforeunload", () => {
      window.__reloaded = true;
    });
    window.__timelineTimer = window.setInterval(() => {
      const text = document.body.innerText;
      const hit = text.includes("本场复盘报告")
        ? "report"
        : text.includes("模拟面试中")
          ? "interview"
          : text.includes("今天想练哪一场")
            ? "workbench"
            : text.includes("岗位与简历材料")
              ? "prepare"
              : text.includes("选择并接入大模型")
                ? "login"
                : "other";
      if (window.__timeline[window.__timeline.length - 1] !== hit) window.__timeline.push(hit);
    }, 250);
  });

  for (let i = 1; i <= rounds; i += 1) {
    await target.click("textarea");
    await target.type("textarea", "我负责过电商中台，用 React 和 TypeScript 拆了组件库，首屏从 3.2 秒降到 1.8 秒。");
    await waitForEnabledButton(target, "发送回答");
    await clickByText(target, "发送回答");
    if (i < rounds) {
      const next = await waitForBadgeChange(target, `第 ${i} 题`);
      check(`${prefix}4.${i} 模型追问后进入第 ${i + 1} 题`, Boolean(next), next ? next.badge.slice(0, 12) : `仍停留在第 ${i} 题`);
    }
  }

  // 收尾为整场评分再渲染报告，允许较慢；失败时把页面快照打出来，便于定位卡在哪一步。
  const report = await target.waitForSelector(".report-view", { timeout: 90000 }).then(() => true).catch(() => false);
  if (report) {
    check(`${prefix}5 最后一题收尾后生成报告`, true);
    const disclaimer = await target.evaluate(() => document.body.innerText.includes("不代表真实面试结论"));
    check(`${prefix}5b 报告带评分免责与数据流向说明`, disclaimer);
  } else {
    const snapshot = await target.evaluate(() => document.body.innerText.replace(/\s+/g, " ").slice(0, 200));
    const timeline = await target.evaluate(() => {
      window.clearInterval(window.__timelineTimer);
      return { pages: window.__timeline, reloaded: window.__reloaded, url: window.location.href };
    });
    check(
      `${prefix}5 最后一题收尾后生成报告`,
      false,
      `轨迹=${timeline.pages.join("→")} 刷新=${timeline.reloaded} 停留=${timeline.url} :: ${snapshot.slice(0, 90)}`
    );
  }

  const chat = stub.received.filter((item) => item.url && item.url.includes("chat/completions"));
  // 请求体是 JSON 字符串，提示词里的引号会被转义成 \" ——所以标记不能用带引号的 "decision"。
  const asks = chat.filter((item) => item.body.includes("new_dimension"));
  const evals = chat.filter((item) => item.body.includes("维度键名固定为"));
  check(`${prefix}6 上游收到每道题的出题/追问请求`, asks.length >= rounds, `ask=${asks.length} rounds=${rounds}`);
  check(`${prefix}7 上游收到整场评分请求`, evals.length >= 1, `eval=${evals.length}`);
  check(
    `${prefix}8 托管请求带部署方 Token 且使用托管模型`,
    asks.length > 0 && asks[0].auth === `Bearer ${HOSTED_TOKEN}` && asks[0].body.includes(HOSTED_MODEL),
    asks.length ? `${asks[0].auth || "无鉴权头"} / ${asks[0].body.includes(HOSTED_MODEL) ? HOSTED_MODEL : "未使用托管模型"}` : "无请求"
  );
}

(async () => {
  fakeAudioPath = ensureFakeAudio();
  const stub = MANAGE_SERVER ? await startStubUpstream() : { received: [], server: null };
  const app = MANAGE_SERVER ? await startAppServer() : { child: null };
  const hostServer = await startHostServer();
  let hostedApp = null;

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${fakeAudioPath}`,
      "--autoplay-policy=no-user-gesture-required"
    ]
  });

  try {
    if (MANAGE_SERVER) {
      check("A0 应用服务器 /api/health 报告 asr 可用", Boolean(app.health?.asr?.available), JSON.stringify(app.health?.asr || {}));
    }

    if (!SKIP_A) {
      const page = await browser.newPage();
      const consoleErrors = [];
      const pageErrors = [];
      page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
      page.on("pageerror", (err) => pageErrors.push(err.message));

      await page.goto(BASE, { waitUntil: "networkidle2", timeout: 30000 });
      check("A1 生产构建加载无 JS 报错", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 140));
      check("A2 未被内嵌时不显示内嵌提示", (await page.$(".embed-notice")) === null);
      check("A3 无 CSP 拦截报错", !consoleErrors.some((t) => /Content Security Policy/i.test(t)), "");

      const mic = await page.evaluate(async () => {
        const out = { gum: "", recognition: "" };
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          out.gum = `tracks=${stream.getTracks().length}`;
          stream.getTracks().forEach((t) => t.stop());
        } catch (e) { out.gum = `error:${e.name}`; }
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SR) return { ...out, recognition: "unsupported" };
        await new Promise((resolve) => {
          const r = new SR();
          r.lang = "zh-CN";
          let done = false;
          const finish = (v) => {
            if (done) return;
            done = true;
            out.recognition = v;
            try { r.stop(); } catch { /* ignore */ }
            resolve();
          };
          r.onstart = () => finish("started");
          r.onresult = () => finish("result");
          r.onerror = (ev) => finish(`error:${ev.error}`);
          window.setTimeout(() => finish("no-event"), 9000);
          try { r.start(); } catch (e) { finish(`throw:${e.message}`); }
        });
        return out;
      });
      check("A4 伪麦克风 getUserMedia 可用", mic.gum === "tracks=1", mic.gum);
      check("A5 语音识别未被权限/策略拒绝", mic.recognition === "started" || mic.recognition === "result" || (mic.recognition.startsWith("error:") && !/not-allowed/.test(mic.recognition)), mic.recognition);

      await runTextInterview(page, "A6");
    }

    const blocked = await browser.newPage();
    await blocked.goto(`http://127.0.0.1:${HOST_PORT}/`, { waitUntil: "networkidle2", timeout: 30000 });
    const frameBlocked = await findFrame(blocked);
    await frameBlocked.waitForSelector(".embed-notice", { timeout: 25000 });
    const noticeText = await frameBlocked.$eval(".embed-notice", (n) => n.innerText.replace(/\n/g, " "));
    check("B1 内嵌时出现内嵌提示条", /内嵌/.test(noticeText), noticeText.slice(0, 62));
    const hasOpen = await frameBlocked.$eval(".embed-notice", (n) => Array.from(n.querySelectorAll("button")).some((b) => b.textContent.includes("在新窗口打开")));
    check("B2 提示条提供「在新窗口打开」", hasOpen);
    const micBlocked = await probeMic(frameBlocked);
    check("B3 父页未授权时麦克风被浏览器拒绝（符合预期）", micBlocked.startsWith("denied:"), micBlocked);
    await runTextInterview(frameBlocked, "B4");
    check("B5 内嵌且无麦克风权限时文字面试仍完整可用", results.filter((r) => r.name.startsWith("B4")).every((r) => r.ok));

    const allowed = await browser.newPage();
    await allowed.goto(`http://127.0.0.1:${HOST_PORT}/allow`, { waitUntil: "networkidle2", timeout: 30000 });
    const frameAllowed = await findFrame(allowed);
    await frameAllowed.waitForSelector(".embed-notice", { timeout: 25000 });
    const micAllowed = await probeMic(frameAllowed);
    check("C1 宿主页带 allow 时内嵌可使用麦克风", micAllowed === "granted", micAllowed);
    const speech = await frameAllowed.evaluate(async () => {
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR) return "unsupported";
      return new Promise((resolve) => {
        const r = new SR();
        r.lang = "zh-CN";
        let done = false;
        const finish = (v) => { if (!done) { done = true; try { r.stop(); } catch { /* ignore */ } resolve(v); } };
        r.onstart = () => finish("started");
        r.onerror = (ev) => finish(`error:${ev.error}`);
        window.setTimeout(() => finish("no-event"), 9000);
        try { r.start(); } catch (e) { finish(`throw:${e.message}`); }
      });
    });
    check("C2 宿主页授权后语音识别可启动", speech === "started" || (speech.startsWith("error:") && !/not-allowed/.test(speech)), speech);

    if (MANAGE_SERVER) {
      // 独立上下文：这一段要和 A/B/C 的 localStorage 设置完全隔离。
      const voiceContext = await browser.createBrowserContext();
      const voice = await voiceContext.newPage();
      await voice.goto(BASE, { waitUntil: "networkidle2", timeout: 30000 });
      await runVoiceAsrInterview(voice, "D");
      const audio = stub.received.filter((item) => item.url && item.url.includes("audio/transcriptions"));
      check(
        "D5 上游收到真实录制的音频并带部署方 Token",
        audio.length >= 1 && audio[0].bytes > 2000 && audio[0].auth === "Bearer stub-token",
        JSON.stringify(audio[0] ? { url: audio[0].url, auth: audio[0].auth, bytes: audio[0].bytes } : {})
      );
      await voiceContext.close();

      // 另起一个开了托管额度的实例，复现"社区访客不填 Key"的场景。
      hostedApp = await startAppServer({
        port: HOSTED_PORT,
        extraEnv: {
          HOSTED_LLM_TOKEN: HOSTED_TOKEN,
          HOSTED_LLM_BASE_URL: `http://127.0.0.1:${ASR_PORT}/v1`,
          HOSTED_LLM_MODEL: HOSTED_MODEL
        }
      });
      const hostedContext = await browser.createBrowserContext();
      const hosted = await hostedContext.newPage();
      await hosted.goto(hostedApp.base, { waitUntil: "networkidle2", timeout: 30000 });
      await runHostedModelInterview(hosted, "E", stub);
      await hostedContext.close();
    }
  } catch (err) {
    check("E2E 执行", false, err.message);
  } finally {
    await browser.close();
    hostServer.close();
    if (stub.server) stub.server.close();
    if (app.child) app.child.kill("SIGKILL");
    if (hostedApp && hostedApp.child) hostedApp.child.kill("SIGKILL");
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
  if (failed.length) {
    console.log("FAILED: " + failed.map((f) => f.name).join(", "));
    process.exitCode = 1;
  }
})();
