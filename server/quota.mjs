// 公开部署保护：滑动窗口限流 + 全局每日额度。
// 目标是"防止单个访客把服务打满/把 Key 烧光"，不是精确计费，所以实现刻意保持简单、无外部依赖。

export function createSlidingWindowLimiter({ windowMs, max }) {
  const hits = new Map();

  function prune(now) {
    for (const [key, times] of hits) {
      const alive = times.filter((ts) => now - ts < windowMs);
      if (alive.length) hits.set(key, alive);
      else hits.delete(key);
    }
  }

  return {
    // 返回 { ok, retryAfterMs }；ok=false 时调用方应回 429。
    take(key) {
      const now = Date.now();
      if (hits.size > 5000) prune(now);
      const times = (hits.get(key) || []).filter((ts) => now - ts < windowMs);
      if (times.length >= max) {
        const retryAfterMs = Math.max(0, windowMs - (now - times[0]));
        hits.set(key, times);
        return { ok: false, retryAfterMs };
      }
      times.push(now);
      hits.set(key, times);
      return { ok: true, retryAfterMs: 0 };
    },
    reset() {
      hits.clear();
    }
  };
}

export function createDailyBudget({ max }) {
  let day = "";
  let used = 0;

  function rollover() {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== day) {
      day = today;
      used = 0;
    }
  }

  return {
    // 先 rollover 再判断，跨天自动重置；max<=0 视为不限额。
    take() {
      rollover();
      if (max <= 0) return { ok: true, remaining: Number.POSITIVE_INFINITY };
      if (used >= max) return { ok: false, remaining: 0 };
      used += 1;
      return { ok: true, remaining: max - used };
    },
    snapshot() {
      rollover();
      return { day, used, max };
    },
    reset() {
      day = "";
      used = 0;
    }
  };
}

// 取客户端标识：反代（如 ModelScope 创空间）会带 X-Forwarded-For，否则退回 socket 地址。
// X-Forwarded-For 可伪造，因此它只用于"软限流"，真正的成本兜底是全局每日额度。
export function clientKey(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  if (forwarded) return forwarded;
  const real = String(req.headers["x-real-ip"] || "").trim();
  if (real) return real;
  return req.socket?.remoteAddress || "unknown";
}