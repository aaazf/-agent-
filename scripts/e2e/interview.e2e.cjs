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
function startStubAsr() {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      received.push({
        url: req.url,
        auth: req.headers.authorization,
        contentType: req.headers["content-type"],
        bytes: Buffer.concat(chunks).length
      });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ text: TRANSCRIPT }));
    });
  });
  return new Promise((resolve) => server.listen(ASR_PORT, "127.0.0.1", () => resolve({ server, received })));
}

async function startAppServer() {
  const child = spawn(process.execPath, ["server/index.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(APP_PORT),
      ASR_BASE_URL: `http://127.0.0.1:${ASR_PORT}/v1`,
      ASR_MODEL: "stub-asr",
      ASR_TOKEN: "stub-token"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  for (let i = 0; i < 40; i += 1) {
    await sleep(300);
    try {
      const res = await fetch(`${BASE}/api/health`, { method: "POST" });
      if (res.ok) return { child, health: await res.json() };
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

(async () => {
  fakeAudioPath = ensureFakeAudio();
  const stub = MANAGE_SERVER ? await startStubAsr() : { received: [], server: null };
  const app = MANAGE_SERVER ? await startAppServer() : { child: null };
  const hostServer = await startHostServer();

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
      check(
        "D5 上游收到真实录制的音频并带部署方 Token",
        stub.received.length >= 1 && stub.received[0].bytes > 2000 && stub.received[0].auth === "Bearer stub-token",
        JSON.stringify(stub.received[0] || {})
      );
      await voiceContext.close();
    }
  } catch (err) {
    check("E2E 执行", false, err.message);
  } finally {
    await browser.close();
    hostServer.close();
    if (stub.server) stub.server.close();
    if (app.child) app.child.kill("SIGKILL");
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
  if (failed.length) {
    console.log("FAILED: " + failed.map((f) => f.name).join(", "));
    process.exitCode = 1;
  }
})();
