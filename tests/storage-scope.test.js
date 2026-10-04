import { beforeEach, describe, expect, it } from "vitest";
import {
  adoptLegacyLocalData,
  clearLocalData,
  clearStorageScope,
  currentStorageScope,
  deleteResult,
  hasOnboarded,
  loadHistory,
  loadSession,
  loadSettings,
  loadTheme,
  markOnboarded,
  saveSession,
  saveSettings,
  saveTheme,
  scopedKey,
  setStorageScope
} from "../src/lib/storage.js";

// 每个用例都从"干净浏览器 + 未登录"开始
beforeEach(() => {
  clearStorageScope();
  localStorage.clear();
});

describe("账号作用域", () => {
  it("同一个浏览器上的两个账号互相看不到设置/记录/中场快照", () => {
    setStorageScope("u-alice");
    // 故意用一个非默认值：否则"Bob 拿到默认设置"会让断言白白通过
    saveSettings({ ...loadSettings(), role: "资深前端" });
    saveSession({ history: [{ id: "a1" }] });
    localStorage.setItem(scopedKey("face-interview-history-v1"), JSON.stringify([{ id: "a1" }]));
    markOnboarded();

    setStorageScope("u-bob");
    // Bob 是全新账号：不该继承 Alice 的岗位设置、记录或"上一场没面完"
    expect(loadSettings().role).toBe("前端工程师");
    expect(loadHistory()).toEqual([]);
    expect(loadSession()).toBeNull();
    expect(hasOnboarded()).toBe(false);

    // 换回 Alice，数据都还在
    setStorageScope("u-alice");
    expect(loadSettings().role).toBe("资深前端");
    expect(loadHistory()).toEqual([{ id: "a1" }]);
    expect(loadSession()).toEqual({ history: [{ id: "a1" }] });
    expect(hasOnboarded()).toBe(true);
  });

  it("未登录时不加后缀，保持与旧版本一致的 key", () => {
    expect(currentStorageScope()).toBe("");
    expect(scopedKey("face-interview-settings-v1")).toBe("face-interview-settings-v1");
    // setStorageScope 传的是账号 id，前缀由 storage 自己加
    setStorageScope("alice");
    expect(scopedKey("face-interview-settings-v1")).toBe("face-interview-settings-v1::u-alice");
  });

  it("deleteResult 只动当前账号的记录", () => {
    setStorageScope("u-alice");
    localStorage.setItem(scopedKey("face-interview-history-v1"), JSON.stringify([{ id: "a1" }, { id: "a2" }]));
    expect(deleteResult("a1").map((item) => item.id)).toEqual(["a2"]);
    setStorageScope("u-bob");
    expect(loadHistory()).toEqual([]);
  });

  it("主题偏好不跟账号走（换个人登录不改这台机器的外观）", () => {
    setStorageScope("u-alice");
    saveTheme("ocean");
    setStorageScope("u-bob");
    expect(loadTheme()).toBe("ocean");
  });
});

describe("老数据归属与清除范围", () => {
  it("首次登录把登录前留下的无后缀数据认领到当前账号", () => {
    // 模拟旧版本：所有数据都写在无后缀 key 上
    localStorage.setItem("face-interview-settings-v1", JSON.stringify({ role: "资深前端" }));
    localStorage.setItem("face-interview-history-v1", JSON.stringify([{ id: "old" }]));
    localStorage.setItem("agent-onboarded", "1");

    setStorageScope("u-alice");
    expect(adoptLegacyLocalData()).toBe(true);

    expect(loadSettings().role).toBe("资深前端");
    expect(loadHistory()).toEqual([{ id: "old" }]);
    expect(hasOnboarded()).toBe(true);
    // 无后缀的旧位置必须清掉：否则下一个登录的人也会认领到同一份数据
    expect(localStorage.getItem("face-interview-settings-v1")).toBeNull();

    clearStorageScope();
    setStorageScope("u-bob");
    expect(adoptLegacyLocalData()).toBe(false);
    expect(loadHistory()).toEqual([]);
  });

  it("一键清除只清当前账号，别的账号在同一台电脑上的缓存不受影响", () => {
    setStorageScope("u-alice");
    saveSettings({ ...loadSettings(), role: "前端" });
    saveTheme("gold");
    setStorageScope("u-bob");
    saveSession({ history: [{ id: "b1" }] });

    setStorageScope("u-alice");
    clearLocalData();
    expect(loadSettings().role).not.toBe("前端");

    setStorageScope("u-bob");
    expect(loadSession()).toEqual({ history: [{ id: "b1" }] });
    // 主题是本机偏好（不跟账号走），按"清干净"的语义会被一并清掉，
    // 清完之后 App 会立刻把当前主题写回去。
    expect(loadTheme()).toBe("");
  });
});
