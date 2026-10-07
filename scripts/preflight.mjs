// 部署自检：把"这个创空间能不能给社区用"的关键项一次跑完，
// 免得部署完才发现托管模型名不在上游清单里、或访客根本拿不到共享额度。
//
// 用法：
//   npm run preflight                          # 检查本地 http://127.0.0.1:7860
//   npm run preflight -- https://<创空间域名>    # 检查已部署的创空间
//
// 登录态往返核验默认用一个一次性账号：注册 → 读登录态 → 立刻注销，不在体验站里留垃圾数据。
// 想换成自己的探针账号：PREFLIGHT_ACCOUNT=<账号> PREFLIGHT_PASSWORD=<密码> npm run preflight -- <域名>
// 不想让预检写数据库（跳过一次性账号那一步）：PREFLIGHT_NO_SIGNUP=1
//
// 退出码非 0 表示有"必须处理"的项。WARN 项都有可用的降级路径，按需处理。
import { pathToFileURL } from "node:url";

export const DEFAULT_BASE = "http://127.0.0.1:7860";

function check(name, ok, detail, required = true) {
  return { name, ok, detail, required };
}

// 纯函数：把 /api/health 的结果翻译成"要不要改配置"的清单。
// required=false 的项只提示，不影响退出码——它们都有降级路径（浏览器 TTS、浏览器识别、文字作答）。
export function evaluateHealth(health) {
  const checks = [];
  if (!health || typeof health !== "object") {
    return [check("接口存活", false, "未拿到 /api/health 响应")];
  }
  checks.push(check("接口存活", health.ok === true, health.ok ? "/api/health 返回 ok" : "响应里没有 ok"));

  const hosted = health.hostedLlm;
  if (hosted?.enabled) {
    checks.push(check("共享额度", true, `已开启，单访客每日 ${hosted.perIpPerDay} 次，模型 ${hosted.model}`));
    // 全站额度一旦用尽，所有访客都会被拒；提前给出预警，而不是等投诉。
    const budget = hosted.dailyBudget;
    if (budget && budget.max > 0) {
      const ratio = budget.used / budget.max;
      checks.push(
        check(
          "当日额度余量",
          ratio < 0.8,
          `已用 ${budget.used} / ${budget.max}${ratio >= 0.8 ? "，接近上限，建议调大 HOSTED_REQUESTS_PER_DAY 或改用自带 Key" : ""}`,
          false
        )
      );
    }
    if (hosted.modelAvailable === undefined) {
      checks.push(check("托管模型", true, `未核对上游清单；加 ?deep=1 可核对 ${hosted.model} 是否在架`, false));
    } else if (hosted.modelAvailable === null) {
      checks.push(check("托管模型", false, `无法核对上游清单：${hosted.probeError || "未知原因"}`));
    } else if (hosted.modelAvailable === false) {
      const candidates = (hosted.availableModels || []).slice(0, 6).join("、");
      checks.push(
        check(
          "托管模型",
          false,
          `上游清单里没有 ${hosted.model}，访客会直接看到模型报错；当前在架可用：${candidates || "（未返回清单）"}`
        )
      );
    } else {
      checks.push(check("托管模型", true, `${hosted.model} 在上游清单中`));
    }
  } else {
    checks.push(
      check(
        "共享额度",
        false,
        "未配置 HOSTED_LLM_TOKEN：访客必须自带 API Key 才能用模型，社区体验会明显变差",
        false
      )
    );
  }

  const tts = health.tts;
  checks.push(
    check(
      "语音播报",
      Boolean(tts?.available),
      tts?.available ? "Edge TTS 可用" : `降级为浏览器内置 TTS（${tts?.reason || "原因未知"}）`,
      false
    )
  );

  const asr = health.asr;
  checks.push(
    check(
      "语音识别",
      Boolean(asr?.available),
      asr?.available
        ? `服务端识别已启用（${asr.model}），访客无需自带 Key`
        : `降级为浏览器识别/文字作答（${asr?.reason || "原因未知"}）`,
      false
    )
  );

  const limits = health.limits;
  const limitsOk =
    limits && Number.isFinite(limits.llmPerMinute) && Number.isFinite(limits.asrPerDay) && Number.isFinite(limits.maxBodyBytes);
  checks.push(
    check("成本闸门", Boolean(limitsOk), limitsOk ? JSON.stringify(limits) : "limits 字段缺失，无法确认限额是否生效")
  );

  // 账号体系：这是登录页能不能用的前提。旧版本没有 accounts 字段，
  // 前端会一直停在"注册/登录失败"，所以这里按必须处理来判定。
  const accounts = health.accounts;
  if (!accounts) {
    checks.push(check("账号体系", false, "响应里没有 accounts 字段：这是没有账号功能的旧镜像，登录页会一直失败"));
  } else {
    checks.push(
      check(
        "账号体系",
        true,
        accounts.signup
          ? `注册已开放${accounts.inviteRequired ? "（需要邀请码）" : ""}；当前 ${accounts.users} 个账号 / ${accounts.resumes} 份简历`
          : "注册已关闭（ALLOW_SIGNUP=0），只有已有账号能登录"
      )
    );
    // 创空间容器默认没有持久卷：不挂载的话，账号与简历会在重启后消失，
    // 这是"社区访客第二天回来发现账号没了"的根因，必须显式提示。
    checks.push(
      check(
        "数据持久化",
        accounts.persistent === true,
        accounts.persistent
          ? "账号与简历已落盘（重启后仍在）"
          : `数据目录不可写或未挂载持久卷，容器重启后账号与简历会丢失（${accounts.reason || "原因未知"}）`,
        false
      )
    );
    if (accounts.signup && !accounts.inviteRequired) {
      checks.push(
        check("注册防线", false, "注册完全开放且没有邀请码，公开体验站建议设置 SIGNUP_INVITE_CODE", false)
      );
    }
  }

  return checks;
}

// 纯函数：未登录访问受保护接口必须回 401。
// 账号类故障里最致命的是"越权"，而它往往表现为这里返回了 200。
export function evaluateAuthBoundary({ me, resumes } = {}) {
  return [
    check("认证边界 · 会话自检", me === 401, `不带 token 请求 /api/auth/me 返回 ${me}`),
    check("认证边界 · 简历读取", resumes === 401, `不带 token 请求 /api/resumes 返回 ${resumes}`)
  ];
}

// 纯函数：登录态往返核验（登进去之后，登录态到底还能不能用）。
// 只验"不带 token → 401"是个假安心：ModelScope 创空间的边缘网关会拦掉非空的
// Authorization 头，直接回 403，请求根本到不了应用。前端一旦把 token 塞进这个头，
// 症状就是登录成功后一进受保护页面就被弹回登录页（用户报的正是这个）。
// 所以必须正面验一次：带 X-Auth-Token 要能读到自己的账号。
export function evaluateAuthRoundTrip({ customHeader, bearer } = {}) {
  return [
    check(
      "登录态 · X-Auth-Token",
      customHeader === 200,
      customHeader === 200
        ? "带 X-Auth-Token 能读到当前账号"
        : `带 X-Auth-Token 请求 /api/auth/me 返回 ${customHeader}：登录后进受保护页面会被弹回登录页，先确认服务端与客户端都在用 X-Auth-Token`
    ),
    check(
      "网关行为 · Authorization 头",
      true,
      bearer === 403
        ? "带 Authorization 返回 403：被边缘网关拦下（ModelScope 创空间的既定行为），客户端不要再用这个头"
        : `带 Authorization 返回 ${bearer}：本次没被网关拦截`,
      false
    )
  ];
}

// 纯函数：一次性探针账号必须能注销干净，否则预检会在体验站里留垃圾账号。
export function evaluateProbeCleanup({ deleted, afterDelete } = {}) {
  return [
    check("探针账号清理", deleted === 200, `注销一次性探针账号返回 ${deleted}`, true),
    check("注销后会话失效", afterDelete === 401, `注销后再拿旧 token 读到 ${afterDelete}`)
  ];
}

// 纯函数：首页必须是能跑起来的生产构建（不能只返回一个空白壳）。
export function evaluatePage(html, statusCode) {
  const checks = [];
  checks.push(check("静态页面", statusCode === 200, `GET / 返回 ${statusCode}`));
  const text = String(html || "");
  const hasRoot = text.includes('id="root"');
  checks.push(check("页面挂载点", hasRoot, hasRoot ? "index.html 含 #root" : "index.html 里没有 #root，可能不是构建产物"));
  const hasEntry = /<script[^>]+src="[^"]*assets\/[^"]+\.js"/.test(text);
  checks.push(check("前端产物", hasEntry, hasEntry ? "已引用打包后的 JS" : "未找到 assets/*.js 引用，请确认先执行了 npm run build"));
  return checks;
}

export function summarize(checks) {
  const failed = checks.filter((item) => !item.ok && item.required);
  const warnings = checks.filter((item) => !item.ok && !item.required);
  const passed = checks.length - failed.length - warnings.length;
  return { passed, failed, warnings, ok: failed.length === 0 };
}

function report(base, checks) {
  console.log(`\nAI 模拟面试 · 部署自检  ${base}`);
  checks.forEach((item) => {
    const mark = item.ok ? "PASS" : item.required ? "FAIL" : "WARN";
    console.log(`  [${mark}] ${item.name}：${item.detail}`);
  });
  const { passed, failed, warnings } = summarize(checks);
  console.log(`\n==== ${passed} PASS / ${warnings.length} WARN / ${failed.length} FAIL ====`);
  if (warnings.length) console.log("建议处理：" + warnings.map((item) => item.name).join("、"));
  if (failed.length) {
    console.log("必须处理：" + failed.map((item) => item.name).join("、"));
    console.log("（详见 docs/deploy-modelscope.md 第 4、5 节）");
    process.exitCode = 1;
  }
}

async function postJson(url, payload, headers = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20000)
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

async function getWithToken(url, headers) {
  try {
    const res = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(20000) });
    return res.status;
  } catch {
    return 0;
  }
}

// 正面验一次"登录之后登录态真的能用"：探针账号优先取 PREFLIGHT_ACCOUNT / PREFLIGHT_PASSWORD；
// 没给就在注册开放时注册一个一次性账号，验完立刻注销。
async function checkAuthRoundTrip(base, checks, accounts) {
  const account = String(process.env.PREFLIGHT_ACCOUNT || "").trim();
  const password = String(process.env.PREFLIGHT_PASSWORD || "");
  let token = "";
  let probe = null;

  if (account && password) {
    const login = await postJson(`${base}/api/auth/login`, { account, password });
    if (login.status !== 200 || !login.data?.token) {
      checks.push(check("登录态 · X-Auth-Token", false, `探针账号 ${account} 登录失败，返回 ${login.status}`));
      return;
    }
    token = login.data.token;
  } else if (accounts?.signup && process.env.PREFLIGHT_NO_SIGNUP !== "1") {
    probe = { account: `preflight-${Date.now().toString(36)}`, password: "Preflight1probe2" };
    const register = await postJson(`${base}/api/auth/register`, probe);
    if (register.status !== 200 || !register.data?.token) {
      checks.push(check("登录态 · X-Auth-Token", false, `一次性探针账号注册失败，返回 ${register.status}`));
      return;
    }
    token = register.data.token;
  } else {
    checks.push(
      check(
        "登录态 · X-Auth-Token",
        true,
        "没给 PREFLIGHT_ACCOUNT / PREFLIGHT_PASSWORD（且注册已关闭），跳过登录态往返核验",
        false
      )
    );
    return;
  }

  const customHeader = await getWithToken(`${base}/api/auth/me`, { "X-Auth-Token": token });
  const bearer = await getWithToken(`${base}/api/auth/me`, { Authorization: `Bearer ${token}` });
  checks.push(...evaluateAuthRoundTrip({ customHeader, bearer }));

  if (!probe) return;

  const removed = await postJson(`${base}/api/account/delete`, { password: probe.password }, { "X-Auth-Token": token });
  const afterDelete = await getWithToken(`${base}/api/auth/me`, { "X-Auth-Token": token });
  checks.push(...evaluateProbeCleanup({ deleted: removed.status, afterDelete }));
}

async function main() {
  const base = (process.argv[2] || process.env.PREFLIGHT_BASE || DEFAULT_BASE).replace(/\/+$/, "");
  const checks = [];

  let health = null;
  try {
    const res = await fetch(`${base}/api/health?deep=1`, { method: "POST", signal: AbortSignal.timeout(20000) });
    if (res.ok) health = await res.json();
    else checks.push(check("接口存活", false, `POST /api/health?deep=1 返回 ${res.status}`));
  } catch (err) {
    checks.push(check("接口存活", false, `${base} 不可达：${err?.message || err}`));
  }
  checks.push(...evaluateHealth(health));

  try {
    const [me, resumes] = await Promise.all([
      fetch(`${base}/api/auth/me`, { method: "GET", signal: AbortSignal.timeout(20000) }),
      fetch(`${base}/api/resumes`, { method: "GET", signal: AbortSignal.timeout(20000) })
    ]);
    checks.push(...evaluateAuthBoundary({ me: me.status, resumes: resumes.status }));
  } catch (err) {
    checks.push(check("认证边界", false, `认证接口不可达：${err?.message || err}`));
  }

  try {
    await checkAuthRoundTrip(base, checks, health?.accounts);
  } catch (err) {
    checks.push(check("登录态 · X-Auth-Token", false, `登录态往返核验失败：${err?.message || err}`));
  }

  try {
    const res = await fetch(base, { signal: AbortSignal.timeout(20000) });
    checks.push(...evaluatePage(await res.text(), res.status));
  } catch (err) {
    checks.push(check("静态页面", false, `首页不可达：${err?.message || err}`));
  }

  report(base, checks);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
