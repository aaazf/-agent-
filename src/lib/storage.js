export const MAX_RESULTS = 7;
const SETTINGS_KEY = "face-interview-settings-v1";
const HISTORY_KEY = "face-interview-history-v1";
const CONSENT_KEY = "face-interview-consent-v1";
const SESSION_KEY = "face-interview-session-v1";
// 引导标记也按账号隔离：换个人登录应该重新走一遍引导，而不是被告知"你已经用过了"。
const ONBOARD_KEY = "agent-onboarded";
// 主题是"这台机器的外观偏好"，不跟账号走。
const THEME_KEY = "guide-theme";

export const DIMENSIONS = [
  { key: "communication", label: "沟通表达" },
  { key: "professional", label: "专业深度" },
  { key: "matching", label: "岗位匹配" },
  { key: "clarity", label: "条理结构" },
  { key: "composure", label: "临场稳定" }
];

export const DEFAULT_SETTINGS = {
  direction: "互联网",
  role: "前端工程师",
  customRole: "",
  resume: "3 年 React / TypeScript 开发经验，负责过电商中台与数据可视化项目。\n项目：电商运营看板\n- 负责组件库与状态管理\n- 优化首屏加载，性能提升 40%",
  jd: "熟悉 React、TypeScript；负责页面开发、性能优化、跨团队协作；加分项：组件库、工程化、可视化。",
  style: "温和引导",
  questionCount: 6,
  cameraOn: false,
  interviewMode: "voice",
  autoSpeak: true,
  voiceName: "auto",
  bufferEnabled: true,
  bufferSeconds: 8,
  modelEnabled: true,
  modelProvider: "openai",
  baseUrl: "https://api.openai.com/v1",
  modelName: "gpt-4o-mini",
  apiKey: ""
};

export function uid() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `s-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// ---------- 账号作用域 ----------
// 每个账号的本机数据都带自己的后缀。不这么做的话，同一台电脑上换个人登录，
// 会直接看到上一个人的面试记录、设置和"上一场没面完"的快照。
let scope = "";

export function setStorageScope(userId) {
  const id = String(userId || "").trim().slice(0, 48);
  scope = id ? `u-${id}` : "";
}

export function clearStorageScope() {
  scope = "";
}

export function currentStorageScope() {
  return scope;
}

// 未登录（离线降级、本地开发）时不加后缀，保持和旧版本一致的行为。
export function scopedKey(base) {
  return scope ? `${base}::${scope}` : base;
}

function readItem(base) {
  try {
    return localStorage.getItem(scopedKey(base));
  } catch {
    return null;
  }
}

function writeItem(base, value) {
  try {
    localStorage.setItem(scopedKey(base), value);
    return true;
  } catch {
    // 隐私模式 / 配额写满：功能降级，不打扰用户
    return false;
  }
}

function removeItem(base) {
  try {
    localStorage.removeItem(scopedKey(base));
  } catch {
    // 忽略
  }
}

// ---------- 迁移与清除 ----------
const SCOPED_BASES = [SETTINGS_KEY, HISTORY_KEY, CONSENT_KEY, SESSION_KEY, ONBOARD_KEY];

// 首次登录时，把"还没登录时留在本机的数据"归到当前账号名下。
// 旧版本所有数据都存无后缀 key：直接丢弃等于把老访客的资料删了；
// 而继续留在无后缀位置，又会被下一个登录的人看到，所以是"认领并迁移"。
export function adoptLegacyLocalData() {
  if (!scope) return false;
  let moved = false;
  for (const base of SCOPED_BASES) {
    try {
      const legacy = localStorage.getItem(base);
      if (legacy === null) continue;
      const target = scopedKey(base);
      if (localStorage.getItem(target) === null) localStorage.setItem(target, legacy);
      localStorage.removeItem(base);
      moved = true;
    } catch {
      // 单项失败不影响其他项
    }
  }
  return moved;
}

// 一键清除本机数据：只清当前账号名下的键（以及旧版的无后缀残留），
// 不会顺手把别的账号在同一台电脑上的缓存也删掉。
// 主题属于"本机偏好"，按"清干净"的语义一并清掉（调用方会立刻写回当前主题）。
export function clearLocalData() {
  try {
    const suffix = scope ? `::${scope}` : "";
    for (const key of Object.keys(localStorage)) {
      const scoped = suffix && key.endsWith(suffix);
      const legacy =
        !key.includes("::") && (key.startsWith("face-interview-") || key === ONBOARD_KEY || key === THEME_KEY);
      if (scoped || legacy) localStorage.removeItem(key);
    }
  } catch {
    // 忽略
  }
}

// ---------- 主题与引导标记 ----------
export function loadTheme() {
  try {
    return localStorage.getItem(THEME_KEY) || "";
  } catch {
    return "";
  }
}

export function saveTheme(theme) {
  try {
    localStorage.setItem(THEME_KEY, String(theme));
  } catch {
    // 忽略
  }
}

export function hasOnboarded() {
  return readItem(ONBOARD_KEY) === "1";
}

export function markOnboarded() {
  return writeItem(ONBOARD_KEY, "1");
}

// ---------- 设置 / 记录 / 告知 / 中场快照 ----------
export function loadSettings() {
  const raw = readItem(SETTINGS_KEY);
  if (raw) {
    try {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch {
      // 内容损坏时回落到默认设置
    }
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(settings) {
  return writeItem(SETTINGS_KEY, JSON.stringify(settings));
}

export function loadHistory() {
  const raw = readItem(HISTORY_KEY);
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function persistHistory(list) {
  return writeItem(HISTORY_KEY, JSON.stringify(list.slice(0, MAX_RESULTS)));
}

export function addResult(result) {
  const list = [result, ...loadHistory()].slice(0, MAX_RESULTS);
  persistHistory(list);
  return list;
}

export function deleteResult(id) {
  const list = loadHistory().filter((item) => item.id !== id);
  persistHistory(list);
  return list;
}

// 语音告知的确认状态：只记"是否已被告知录音如何被处理"，不记任何音频内容。
export function loadConsent() {
  const raw = readItem(CONSENT_KEY);
  if (raw) {
    try {
      return { voiceUpload: false, ...JSON.parse(raw) };
    } catch {
      // 忽略损坏内容
    }
  }
  return { voiceUpload: false };
}

export function saveConsent(patch) {
  const next = { ...loadConsent(), ...patch };
  writeItem(CONSENT_KEY, JSON.stringify(next));
  return next;
}

// 中场快照：只存"这场面试已经答完的轮次"，用于刷新后接着面完。
// 面试正常结束或用户明确重开时会清掉，避免陈旧快照一直提示"继续"。
export function loadSession() {
  const raw = readItem(SESSION_KEY);
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch {
      // 忽略损坏内容
    }
  }
  return null;
}

export function saveSession(snapshot) {
  return writeItem(SESSION_KEY, JSON.stringify(snapshot));
}

export function clearSession() {
  removeItem(SESSION_KEY);
}

export function formatTime(ts) {
  const date = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function secondsLabel(ms) {
  if (!ms) return "0 秒";
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s} 秒`;
  return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}
