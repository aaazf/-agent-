// 中场快照：一次语音面试动辄十几分钟，刷新、误关页面或手机切后台都会把它清空。
// 这里只保留"已经答完的轮次"，让下一位访客（或同一位）能接着面完，
// 而不是从头再来一遍。
export const SESSION_VERSION = 1;
export const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;

// 快照只对"同一场面试"有效：方向、岗位、面试形式、题数任一变化都算另一场。
function sameInterview(a, b) {
  return (
    a?.direction === b?.direction &&
    a?.role === b?.role &&
    (a?.interviewMode || "voice") === (b?.interviewMode || "voice") &&
    Number(a?.questionCount) === Number(b?.questionCount)
  );
}

export function buildSnapshot({ settings, history, startedAt, now = Date.now() }) {
  return {
    version: SESSION_VERSION,
    interview: {
      direction: settings?.direction,
      role: settings?.role,
      interviewMode: settings?.interviewMode || "voice",
      questionCount: Number(settings?.questionCount) || 0
    },
    history: Array.isArray(history) ? history : [],
    startedAt: startedAt || now,
    updatedAt: now
  };
}

// 能不能接着面：版本一致、同一场面试、进度在 1..题数-1 之间，且没有过期。
// 纯函数便于单测，也避免把"要不要提示继续"的判断散落在组件里。
export function resumeDecision(snapshot, settings, now = Date.now()) {
  if (!snapshot || snapshot.version !== SESSION_VERSION) {
    return { ok: false, reason: "没有可继续的面试" };
  }
  const answered = Array.isArray(snapshot.history) ? snapshot.history.length : 0;
  if (!answered) return { ok: false, reason: "上一场还没有答完第一题" };
  if (!sameInterview(snapshot.interview, settings)) {
    return { ok: false, reason: "岗位或题数已经变了，按新设置重新开始" };
  }
  const total = Number(settings?.questionCount) || answered;
  if (answered >= total) return { ok: false, reason: "上一场已经答满题数" };
  if (snapshot.updatedAt && now - Number(snapshot.updatedAt) > SESSION_MAX_AGE_MS) {
    return { ok: false, reason: "上一场已经超过 12 小时，自动作废" };
  }
  return { ok: true, answered, total, snapshot };
}
