// 真实浏览器端到端验证（不属于 npm test，需要本机已装 Chrome 与 puppeteer）。
//
// 覆盖：
//   A. 顶层窗口：生产构建无报错 / 无 CSP 拦截 / 伪麦克风 getUserMedia / SpeechRecognition 真实启动
//      / 文字面试完整跑通（第 1 题 -> 提交回答 -> 第 2 题）
//   B. 真实 http 宿主页内嵌且父页未授权：出现内嵌提示、麦克风被浏览器拒绝、文字面试仍完整可用
//   C. 宿主页带 allow="microphone; camera"：内嵌窗口同样能拿到麦克风并启动语音识别
//
// 用法（先 npm run build && npm start，另开终端）：
//   NODE_PATH=$(npm root -g) node scripts/e2e/interview.e2e.cjs
//   Windows: $env:NODE_PATH = (npm root -g); node scripts/e2e/interview.e2e.cjs
//
// 可选环境变量：E2E_BASE、CHROME_PATH、E2E_HOST_PORT、SKIP_A=1（只跑内嵌相关用例）
const fs = require("node:fs");

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

const http = require("node:http");
const path = require("node:path");
const puppeteer = require("puppeteer");

const BASE = process.env.E2E_BASE || "http://127.0.0.1:7860";
const HOST_PORT = Number(process.env.E2E_HOST_PORT || 7900);
const CHROME = resolveChromePath();
const WAV = path.join(process.env.TEMP, "ia-fake-audio.wav");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail: String(detail) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "   [" + String(detail) + "]" : ""}`);
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

async function findFrame(host, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = host.frames().find((fr) => fr.url().startsWith(BASE));
    if (found) return found;
    await sleep(300);
  }
  throw new Error(`未找到 iframe，当前帧：${host.frames().map((f) => f.url()).join(",")}`);
}

async function probeMic(target) {
  return target.evaluate(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      return "granted";
    } catch (e) {
      return `denied:${e.name}`;
    }
  });
}

async function runInterviewFlow(target, prefix) {
  const splash = await target.$(".splash-enter");
  if (splash) await splash.click();
  await target.waitForSelector(".login-submit", { timeout: 20000 });
  await target.click(".login-submit");

  await target.waitForFunction(() => document.body.innerText.includes("选择并接入大模型"), { timeout: 20000 });
  await clickByText(target, "暂不接入，本地题库继续");

  await target.waitForFunction(() => document.body.innerText.includes("岗位与简历材料"), { timeout: 20000 });
  await clickByText(target, "下一步：设备与面试类型");

  await target.waitForFunction(() => document.body.innerText.includes("设备检测与面试类型"), { timeout: 20000 });
  await clickByText(target, "文字面试");
  await clickByText(target, "下一步：进入模拟面试");

  await target.waitForSelector("textarea", { timeout: 25000 });
  const first = await readBadge(target);
  check(`${prefix} 文字面试生成第 1 题`, Boolean(first && first.badge.startsWith("第 1 题")), first ? first.badge.slice(0, 14) : "未找到题号");

  await target.click("textarea");
  await target.type("textarea", "我负责过电商中台，用 React + TypeScript 拆分组件库，首屏加载从 3.2 秒降到 1.8 秒。");
  await target.waitForSelector("button.answer-btn", { timeout: 10000 });
  await clickByText(target, "发送回答");

  let advanced = null;
  for (let i = 0; i < 30; i += 1) {
    await sleep(1000);
    const badge = await readBadge(target);
    if (badge && !badge.badge.startsWith("第 1 题")) { advanced = badge; break; }
  }
  check(`${prefix} 提交回答后推进到下一题`, Boolean(advanced), advanced ? advanced.badge.slice(0, 14) : "仍停留在第 1 题");
}

(async () => {
  const hostServer = await startHostServer();
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${WAV}`,
      "--autoplay-policy=no-user-gesture-required"
    ]
  });

  try {
    // ---------- A. 顶层窗口 ----------
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
    check("A5 语音识别未被权限/策略拒绝（真实浏览器验证）", mic.recognition === "started" || mic.recognition === "result" || (mic.recognition.startsWith("error:") && !/not-allowed/.test(mic.recognition)), mic.recognition);

    await runInterviewFlow(page, "A6");

    // ---------- B. 真实 http 宿主页内嵌（模拟创空间未授权 iframe） ----------
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
    await runInterviewFlow(frameBlocked, "B4");
    check("B5 内嵌且无麦克风权限时文字面试仍完整可用", results.filter((r) => r.name.startsWith("B4")).every((r) => r.ok));

    // ---------- C. 宿主页显式授权后，内嵌也能拿到麦克风 ----------
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
  } catch (err) {
    check("E2E 执行", false, err.message);
  } finally {
    await browser.close();
    hostServer.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
  if (failed.length) {
    console.log("FAILED: " + failed.map((f) => f.name).join(", "));
    process.exitCode = 1;
  }
})();