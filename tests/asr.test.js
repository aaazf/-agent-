import { afterEach, describe, expect, it, vi } from "vitest";
import { transcribeAudio } from "../src/lib/asr.js";

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("transcribeAudio", () => {
  it("refuses an empty recording before touching the network", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(transcribeAudio(null)).rejects.toThrow("没有录到音频");
    await expect(transcribeAudio(new Blob([], { type: "audio/webm" }))).rejects.toThrow("没有录到音频");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uploads the blob as raw audio with the recorded mime type", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { text: "  我说完了  " }));
    vi.stubGlobal("fetch", fetchMock);
    const blob = new Blob(["audio-bytes"], { type: "audio/webm;codecs=opus" });

    await expect(transcribeAudio(blob)).resolves.toBe("我说完了");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/asr?lang=zh");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("audio/webm;codecs=opus");
    expect(init.body).toBe(blob);
  });

  it("honours a custom language", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { text: "hello" }));
    vi.stubGlobal("fetch", fetchMock);
    await transcribeAudio(new Blob(["x"]), { language: "en" });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/asr?lang=en");
  });

  it("maps server error codes to actionable messages", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(503, { error: "x", code: "asr_unavailable" })));
    await expect(transcribeAudio(new Blob(["x"]))).rejects.toThrow("本站未开启服务端语音识别");

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(429, { error: "站点今日语音识别额度已用尽", code: "asr_quota_exceeded" })));
    await expect(transcribeAudio(new Blob(["x"]))).rejects.toThrow("额度已用尽");
  });

  it("reports empty transcripts and network failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { text: "   " })));
    await expect(transcribeAudio(new Blob(["x"]))).rejects.toThrow("没有识别到内容");

    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("offline");
    }));
    await expect(transcribeAudio(new Blob(["x"]))).rejects.toThrow("语音识别请求失败");
  });
});