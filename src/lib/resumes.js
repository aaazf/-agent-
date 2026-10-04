// 简历的服务端读写 + 本机只读缓存。
//
// 简历的"真身"在服务端（跟着账号走，换设备也在），本机只留一份最近一次的
// 只读缓存：服务端连不上时至少还能看到上次的简历，而不是白屏。
import { ApiError, request } from "./auth.js";
import { scopedKey } from "./storage.js";

const CACHE_KEY = "face-interview-resume-cache-v1";
const MAX_CACHE = 20;

export function loadCachedResumes() {
  try {
    const raw = localStorage.getItem(scopedKey(CACHE_KEY));
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function writeCache(list) {
  try {
    localStorage.setItem(scopedKey(CACHE_KEY), JSON.stringify(list.slice(0, MAX_CACHE)));
  } catch {
    // 缓存写不进去不影响主流程
  }
}

// 只挑界面要用的字段：简历正文可能上万字，整包缓存会挤爆 localStorage。
export function toResumePayload({ id = "", title = "", role = "", direction = "", text = "", jd = "", analysis = null } = {}) {
  return {
    id: String(id || ""),
    title: String(title || "").trim(),
    role: String(role || "").trim(),
    direction: String(direction || "").trim(),
    text: String(text || ""),
    jd: String(jd || ""),
    analysis: analysis && typeof analysis === "object" ? analysis : null
  };
}

export async function listResumes() {
  try {
    const data = await request("/api/resumes", { method: "GET" });
    const resumes = Array.isArray(data.resumes) ? data.resumes : [];
    writeCache(resumes);
    return { resumes, cached: false, error: "" };
  } catch (err) {
    if (err instanceof ApiError && err.offline) {
      return { resumes: loadCachedResumes(), cached: true, error: err.message };
    }
    throw err;
  }
}

export async function saveResume(resume) {
  const data = await request("/api/resumes", { body: { resume: toResumePayload(resume) } });
  const saved = data.resume;
  const others = loadCachedResumes().filter((item) => item.id !== saved?.id);
  writeCache(saved ? [saved, ...others] : others);
  return saved;
}

export async function deleteResume(id) {
  await request("/api/resumes/delete", { body: { id } });
  writeCache(loadCachedResumes().filter((item) => item.id !== id));
  return true;
}

// 面试开始前自动存档时用：内容没变就不要重复写一条（否则每点一次开始就多一份简历）。
export function isSameResume(a, b) {
  if (!a || !b) return false;
  return String(a.text || "").trim() === String(b.text || "").trim() && String(a.jd || "").trim() === String(b.jd || "").trim();
}
