import { describe, expect, it } from "vitest";
import {
  PASSWORD_MIN_LENGTH,
  createSessionToken,
  hashPassword,
  hashToken,
  normalizeAccount,
  readBearer,
  validateAccount,
  validatePassword,
  verifyPassword
} from "../server/auth.mjs";

describe("account validation", () => {
  it("accepts an email account and normalizes case/space", () => {
    const checked = validateAccount("  Alice@Example.COM ");
    expect(checked.ok).toBe(true);
    expect(checked.account).toBe("alice@example.com");
    expect(normalizeAccount("Bob")).toBe("bob");
  });

  it("accepts a username so community visitors don't have to give an email", () => {
    expect(validateAccount("zhang_san-01").ok).toBe(true);
    // 纯中文昵称会被拒，因为跨设备登录靠的是可复现的字符集
    expect(validateAccount("张三").ok).toBe(false);
    expect(validateAccount("ab").ok).toBe(false);
    expect(validateAccount("-abc").ok).toBe(false);
  });

  it("rejects empty and malformed emails", () => {
    expect(validateAccount("").ok).toBe(false);
    expect(validateAccount("alice@").ok).toBe(false);
    expect(validateAccount("alice@example").ok).toBe(false);
    expect(validateAccount("a b@example.com").ok).toBe(false);
  });
});

describe("password policy", () => {
  it("requires length plus letters and digits", () => {
    expect(validatePassword("short1").ok).toBe(false);
    expect(validatePassword("x".repeat(PASSWORD_MIN_LENGTH + 1)).ok).toBe(false);
    expect(validatePassword("interview2026").ok).toBe(true);
  });

  it("rejects absurdly long passwords to bound scrypt cost", () => {
    expect(validatePassword(`a1${"x".repeat(200)}`).ok).toBe(false);
  });
});

describe("password hashing", () => {
  it("stores parameters with the hash and verifies the right password", () => {
    const stored = hashPassword("interview2026");
    expect(stored.startsWith("scrypt$")).toBe(true);
    expect(stored).not.toContain("interview2026");
    expect(verifyPassword("interview2026", stored)).toBe(true);
    expect(verifyPassword("interview2027", stored)).toBe(false);
  });

  it("salts each hash so identical passwords don't collide", () => {
    expect(hashPassword("interview2026")).not.toBe(hashPassword("interview2026"));
  });

  it("returns false instead of throwing on a damaged stored value", () => {
    for (const broken of ["", "plaintext", "scrypt$1$2", "scrypt$a$b$c$d$e"]) {
      expect(verifyPassword("interview2026", broken)).toBe(false);
    }
  });
});

describe("session tokens", () => {
  it("issues an unguessable token and stores only its hash", () => {
    const first = createSessionToken();
    const second = createSessionToken();
    expect(first.token).not.toBe(second.token);
    expect(first.token.length).toBeGreaterThanOrEqual(40);
    expect(first.tokenHash).toBe(hashToken(first.token));
    expect(first.tokenHash).not.toContain(first.token);
  });

  it("parses only well-formed bearer headers", () => {
    expect(readBearer({ headers: { authorization: "Bearer abc" } })).toBe("abc");
    expect(readBearer({ headers: { authorization: "bearer  spaced " } })).toBe("spaced");
    expect(readBearer({ headers: { authorization: "Basic abc" } })).toBe("");
    expect(readBearer({ headers: {} })).toBe("");
    expect(readBearer({})).toBe("");
  });
});
