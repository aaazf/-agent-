import { describe, expect, it } from "vitest";
import { SESSION_MAX_AGE_MS, SESSION_VERSION, buildSnapshot, resumeDecision } from "../src/lib/session.js";

const settings = { direction: "互联网", role: "前端工程师", interviewMode: "text", questionCount: 6 };
const round = (n) => ({ question: `第 ${n} 题`, answer: "回答", source: "model" });
const makeSnapshot = (answered, patch = {}) =>
  buildSnapshot({ settings: { ...settings, ...(patch.settings || {}) }, history: Array.from({ length: answered }, (_, i) => round(i + 1)), startedAt: 1000, now: 2000 });

describe("中场快照：刷新后能不能接着面", () => {
  it("答过至少一题、还有题没答，就可以接着面", () => {
    const decision = resumeDecision(makeSnapshot(2), settings, 3000);
    expect(decision.ok).toBe(true);
    expect(decision.answered).toBe(2);
    expect(decision.total).toBe(6);
  });

  it("一题都没答完不给继续，避免空白快照骚扰用户", () => {
    expect(resumeDecision(makeSnapshot(0), settings, 3000).ok).toBe(false);
  });

  it("已经答满题数的快照不算未完成", () => {
    expect(resumeDecision(makeSnapshot(6), settings, 3000).ok).toBe(false);
  });

  it("岗位、方向、形式或题数变了就不是同一场，按新设置重开", () => {
    const snapshot = makeSnapshot(2);
    expect(resumeDecision(snapshot, { ...settings, role: "后端工程师" }, 3000).ok).toBe(false);
    expect(resumeDecision(snapshot, { ...settings, direction: "金融" }, 3000).ok).toBe(false);
    expect(resumeDecision(snapshot, { ...settings, interviewMode: "voice" }, 3000).ok).toBe(false);
    expect(resumeDecision(snapshot, { ...settings, questionCount: 8 }, 3000).ok).toBe(false);
  });

  it("超过 12 小时的陈旧快照自动作废", () => {
    const snapshot = makeSnapshot(2);
    expect(resumeDecision(snapshot, settings, snapshot.updatedAt + SESSION_MAX_AGE_MS - 1).ok).toBe(true);
    expect(resumeDecision(snapshot, settings, snapshot.updatedAt + SESSION_MAX_AGE_MS + 1).ok).toBe(false);
  });

  it("版本不一致、内容为空或非数组都不认", () => {
    expect(resumeDecision(null, settings, 3000).ok).toBe(false);
    expect(resumeDecision({ ...makeSnapshot(2), version: SESSION_VERSION + 1 }, settings, 3000).ok).toBe(false);
    expect(resumeDecision({ ...makeSnapshot(2), history: "坏数据" }, settings, 3000).ok).toBe(false);
  });

  it("快照里带上原始轮次，供恢复时放回历史", () => {
    const snapshot = makeSnapshot(3);
    expect(snapshot.version).toBe(SESSION_VERSION);
    expect(resumeDecision(snapshot, settings, 3000).snapshot.history).toHaveLength(3);
  });
});
