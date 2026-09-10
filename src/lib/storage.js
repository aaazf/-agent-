export const MAX_RESULTS = 7;
const SETTINGS_KEY = "face-interview-settings-v1";
const HISTORY_KEY = "face-interview-history-v1";

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

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    // ignore corrupted local storage
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // local demo only
  }
}

export function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function persistHistory(list) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, MAX_RESULTS)));
  } catch {
    // local demo only
  }
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
