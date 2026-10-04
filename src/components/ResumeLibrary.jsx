import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, FileStack, LoaderCircle, Save, Trash2, Upload } from "lucide-react";
import { deleteResume, listResumes, saveResume, toResumePayload } from "../lib/resumes.js";
import { formatTime } from "../lib/storage.js";

// 账号级简历库：列出这个账号已保存的简历，可以载入到当前表单，也可以把表单存回去。
// 简历的真身在服务端（跟账号走），这里只负责交互与失败提示。
export default function ResumeLibrary({ current, onLoad, onSaved, compact = false }) {
  const [list, setList] = useState([]);
  const [state, setState] = useState("loading");
  const [message, setMessage] = useState("");
  const [cached, setCached] = useState(false);
  const [busyId, setBusyId] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const result = await listResumes();
      setList(result.resumes);
      setCached(result.cached);
      setMessage(result.error || "");
      setState("ready");
    } catch (err) {
      setState("error");
      setMessage(err?.message || "读取简历列表失败");
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // 内容相同的简历不重复新建：直接覆盖已有的那条，避免点几次"保存"堆出一串副本。
  function existingIdFor(payload) {
    const match = list.find((item) => String(item.text || "").trim() === String(payload.text || "").trim());
    return match?.id || "";
  }

  async function handleSave() {
    if (busy) return;
    const payload = toResumePayload(current);
    if (!payload.text.trim()) {
      setMessage("简历内容还是空的，先填写或导入简历再保存。");
      setState("error");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const saved = await saveResume({ ...payload, id: existingIdFor(payload) });
      setState("ready");
      setMessage(`已保存到账号：${saved?.title || payload.title || "未命名简历"}`);
      await refresh();
      onSaved?.(saved);
    } catch (err) {
      setState("error");
      setMessage(err?.message || "保存失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  async function handleLoad(resume) {
    setBusyId(resume.id);
    setMessage("");
    try {
      onLoad?.(resume);
      setMessage(`已载入：${resume.title || "未命名简历"}`);
      setState("ready");
    } finally {
      setBusyId("");
    }
  }

  async function handleDelete(resume) {
    if (!window.confirm(`删除简历「${resume.title || "未命名简历"}」？删除后无法恢复。`)) return;
    setBusyId(resume.id);
    try {
      await deleteResume(resume.id);
      await refresh();
      setMessage("已删除。");
    } catch (err) {
      setState("error");
      setMessage(err?.message || "删除失败，请稍后重试。");
    } finally {
      setBusyId("");
    }
  }

  return (
    <section className={`panel resume-library ${compact ? "compact" : ""}`}>
      <div className="resume-library-head">
        <div>
          <span className="eyebrow">
            <FileStack size={13} />
            我的简历库
          </span>
          <h3>账号里的简历</h3>
          <small>共 {list.length} 份 · 换设备登录也能找回</small>
        </div>
        <button type="button" className="small-btn save-resume-lib" onClick={handleSave} disabled={busy}>
          {busy ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />}
          保存当前简历
        </button>
      </div>

      {state === "loading" ? (
        <p className="resume-library-note">
          <LoaderCircle size={13} className="spin" />
          正在读取账号里的简历…
        </p>
      ) : null}

      {message ? (
        <p className={`resume-library-note ${state === "error" ? "warn" : ""}`}>
          {state === "error" ? <AlertTriangle size={13} /> : null}
          {message}
          {cached ? "（当前显示的是本机缓存）" : ""}
        </p>
      ) : null}

      {state !== "loading" && list.length === 0 ? (
        <p className="resume-library-note">还没有保存过简历。填好下面的内容后点「保存当前简历」。</p>
      ) : null}

      {list.length ? (
        <ul className="resume-library-list">
          {list.map((item) => (
            <li key={item.id}>
              <div className="resume-library-meta">
                <b>{item.title || "未命名简历"}</b>
                <small>
                  {[item.direction, item.role].filter(Boolean).join(" · ") || "未填岗位"}
                  {" · "}
                  {formatTime(item.updatedAt)}
                </small>
              </div>
              <div className="resume-library-actions">
                <button
                  type="button"
                  className="small-btn resume-load-btn"
                  disabled={busyId === item.id}
                  onClick={() => handleLoad(item)}
                >
                  <Upload size={13} />
                  载入
                </button>
                <button
                  type="button"
                  className="small-btn danger resume-delete-btn"
                  disabled={busyId === item.id}
                  onClick={() => handleDelete(item)}
                >
                  <Trash2 size={13} />
                  删除
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
