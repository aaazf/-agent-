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

// 按访客分别计数的每日额度。createDailyBudget 只有一个全局计数器，
// 用它冒充"每人每日"会让全站共用一个额度池——一个人刷完，所有人都被拒。
export function createKeyedDailyBudget({ max, maxKeys = 5000 }) {
  let day = "";
  let buckets = new Map();

  function rollover() {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== day) {
      day = today;
      buckets = new Map();
    }
  }

  function total(groups) {
    let sum = 0;
    for (const used of groups.values()) sum += used;
    return sum;
  }

  return {
    // 先 rollover 再判断，跨天自动重置；max<=0 视为不限额。
    take(key) {
      rollover();
      if (max <= 0) return { ok: true, remaining: Number.POSITIVE_INFINITY };
      const id = String(key || "unknown");
      const used = buckets.get(id) || 0;
      if (used >= max) return { ok: false, remaining: 0 };
      // 键数量超过上限时不再为新键记账（放行由全局额度兜底），避免被伪造 IP 撑爆内存。
      if (!buckets.has(id) && buckets.size >= maxKeys) {
        return { ok: true, remaining: max };
      }
      buckets.set(id, used + 1);
      return { ok: true, remaining: max - used - 1 };
    },
    check(key) {
      rollover();
      if (max <= 0) return { ok: true, remaining: Number.POSITIVE_INFINITY };
      const used = buckets.get(String(key || "unknown")) || 0;
      return used >= max ? { ok: false, remaining: 0 } : { ok: true, remaining: max - used };
    },
    snapshot() {
      rollover();
      return { day, max, keys: buckets.size, used: total(buckets) };
    },
    reset() {
      day = "";
      buckets = new Map();
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
