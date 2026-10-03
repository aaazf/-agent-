// 部署自检：把"这个创空间能不能给社区用"的关键项一次跑完，
// 免得部署完才发现托管模型名不在上游清单里、或访客根本拿不到共享额度。
//
// 用法：
//   npm run preflight                          # 检查本地 http://127.0.0.1:7860
//   npm run preflight -- https://<创空间域名>    # 检查已部署的创空间
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

  return checks;
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
