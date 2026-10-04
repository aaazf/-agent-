import { useState } from "react";
import { AlertTriangle, Download, ShieldCheck, Trash2, UserRound } from "lucide-react";
import { request } from "../lib/auth.js";
import { DATA_FLOW, dataRetention } from "../lib/privacy.js";

// 访客自助的"账号与数据"面板：导出、注销、清本机缓存。
// 有了账号体系之后，光有"清除本机数据"是不够的——简历存在服务端，
// 只有把导出与注销也放到界面上，访客才真的能处置自己的数据。
export default function AccountDataPanel({ account, onClearLocal, onDeleted }) {
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  async function exportData() {
    setBusy("export");
    setError("");
    setMessage("");
    try {
      const data = await request("/api/account/export", { method: "GET" });
      const safeName = String(account || "account").replace(/[^\w.@-]/g, "_");
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `面试账号数据-${safeName}.json`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 500);
      setMessage(`已导出账号信息与 ${data.resumes?.length || 0} 份简历。`);
    } catch (err) {
      setError(err?.message || "导出失败，请稍后重试。");
    } finally {
      setBusy("");
    }
  }

  async function deleteAccount() {
    // 注销必须二次验证密码：否则一个被偷的 token 就能把账号连简历一起删掉。
    const password = window.prompt("注销会删除账号与保存的全部简历，且无法恢复。\n请输入登录密码确认：");
    if (password === null) return;
    if (!window.confirm("确认永久注销这个账号？此操作不可撤销。")) return;
    setBusy("delete");
    setError("");
    setMessage("");
    try {
      await request("/api/account/delete", { body: { password } });
      setMessage("账号已注销。");
      onDeleted?.();
    } catch (err) {
      setError(err?.message || "注销失败，请稍后重试。");
    } finally {
      setBusy("");
    }
  }

  return (
    <section className="panel account-data-panel">
      <div className="account-data-head">
        <span className="account-chip">
          <UserRound size={13} />
          {account || "未登录"}
        </span>
        <div>
          <b>账号与数据</b>
          <small>{dataRetention}</small>
        </div>
      </div>

      <p className="account-data-note">
        <ShieldCheck size={13} />
        {DATA_FLOW.account}
      </p>

      {message ? <p className="account-data-note ok">{message}</p> : null}
      {error ? (
        <p className="account-data-note warn">
          <AlertTriangle size={13} />
          {error}
        </p>
      ) : null}

      <div className="account-data-actions">
        <button type="button" className="ghost-btn export-account-btn" onClick={exportData} disabled={busy === "export"}>
          <Download size={15} />
          导出账号数据
        </button>
        {onClearLocal ? (
          <button type="button" className="ghost-btn clear-local-btn" onClick={onClearLocal}>
            <ShieldCheck size={15} />
            清除本机缓存
          </button>
        ) : null}
        <button type="button" className="ghost-btn danger delete-account-btn" onClick={deleteAccount} disabled={busy === "delete"}>
          <Trash2 size={15} />
          注销账号
        </button>
      </div>
      <p className="micro-copy">导出包含账号信息与简历；本机缓存只在本机，清除后需重新填岗位与简历。</p>
    </section>
  );
}
