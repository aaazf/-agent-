import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import useVoiceRecorder, {
  audioExtensionFor,
  isVoiceRecordingSupported,
  pickRecorderMimeType
} from "../src/hooks/useVoiceRecorder.js";

class FakeAnalyser {
  constructor() {
    this.fftSize = 1024;
    this.value = 128;
  }
  getByteTimeDomainData(samples) {
    samples.fill(this.value);
  }
}

class FakeAudioContext {
  static analyser = new FakeAnalyser();
  createAnalyser() {
    return FakeAudioContext.analyser;
  }
  createMediaStreamSource() {
    return { connect: vi.fn() };
  }
  close() {
    this.closed = true;
  }
}

class FakeMediaRecorder {
  static instances = [];
  static isTypeSupported(type) {
    return type === "audio/webm" || type === "audio/webm;codecs=opus";
  }
  constructor(stream, options = {}) {
    this.stream = stream;
    this.mimeType = options.mimeType || "audio/webm";
    this.state = "inactive";
    FakeMediaRecorder.instances.push(this);
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.onstop?.();
  }
}

let frames = [];

function fakeStream() {
  return { getTracks: () => [{ stop: vi.fn() }] };
}

beforeEach(() => {
  FakeMediaRecorder.instances = [];
  FakeAudioContext.analyser.value = 200;
  frames = [];
  window.MediaRecorder = FakeMediaRecorder;
  window.AudioContext = FakeAudioContext;
  window.requestAnimationFrame = (cb) => {
    frames.push(cb);
    return frames.length;
  };
  window.cancelAnimationFrame = vi.fn();
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn().mockResolvedValue(fakeStream()) }
  });
});

afterEach(() => {
  delete window.MediaRecorder;
  delete window.AudioContext;
  vi.restoreAllMocks();
});

describe("recorder capability helpers", () => {
  it("detects support from MediaRecorder plus getUserMedia", () => {
    expect(isVoiceRecordingSupported()).toBe(true);
    delete window.MediaRecorder;
    expect(isVoiceRecordingSupported()).toBe(false);
  });

  it("picks the first supported mime type and maps extensions", () => {
    expect(pickRecorderMimeType()).toBe("audio/webm;codecs=opus");
    expect(audioExtensionFor("audio/webm;codecs=opus")).toBe("webm");
    expect(audioExtensionFor("audio/mp4")).toBe("mp4");
    expect(audioExtensionFor("")).toBe("webm");
  });
});

describe("useVoiceRecorder", () => {
  it("starts recording and reports speaking levels to the caller", async () => {
    const levels = [];
    const { result } = renderHook(() => useVoiceRecorder({ onLevel: (rms, speaking) => levels.push({ rms, speaking }) }));

    await act(async () => {
      const started = await result.current.start();
      expect(started.ok).toBe(true);
    });
    expect(result.current.recording).toBe(true);
    expect(FakeMediaRecorder.instances).toHaveLength(1);
    expect(FakeMediaRecorder.instances[0].mimeType).toBe("audio/webm;codecs=opus");

    act(() => {
      frames.shift()?.();
    });
    expect(levels.length).toBeGreaterThan(0);
    expect(levels[levels.length - 1].speaking).toBe(true);
    expect(levels[levels.length - 1].rms).toBeGreaterThan(0.015);
  });

  it("reports silence when the level is low", async () => {
    FakeAudioContext.analyser.value = 128;
    const levels = [];
    const { result } = renderHook(() => useVoiceRecorder({ onLevel: (_rms, speaking) => levels.push(speaking) }));
    await act(async () => {
      await result.current.start();
    });
    act(() => {
      frames.shift()?.();
    });
    expect(levels[levels.length - 1]).toBe(false);
  });

  it("returns a blob built from the recorder chunks on stop", async () => {
    const { result } = renderHook(() => useVoiceRecorder());
    await act(async () => {
      await result.current.start();
    });
    const recorder = FakeMediaRecorder.instances[0];
    recorder.ondataavailable({ data: new Blob(["第一段"], { type: "audio/webm" }) });
    recorder.ondataavailable({ data: new Blob(["第二段"], { type: "audio/webm" }) });

    let blob = null;
    await act(async () => {
      blob = await result.current.stop();
    });
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.size).toBeGreaterThan(0);
    expect(result.current.recording).toBe(false);
  });

  it("returns null when stopped without any audio", async () => {
    const { result } = renderHook(() => useVoiceRecorder());
    await act(async () => {
      await result.current.start();
    });
    let blob = "unset";
    await act(async () => {
      blob = await result.current.stop();
    });
    expect(blob).toBeNull();
  });

  it("surfaces a denied microphone instead of throwing", async () => {
    navigator.mediaDevices.getUserMedia = vi.fn().mockRejectedValue(Object.assign(new Error("denied"), { name: "NotAllowedError" }));
    const { result } = renderHook(() => useVoiceRecorder());
    let started = null;
    await act(async () => {
      started = await result.current.start();
    });
    expect(started.ok).toBe(false);
    expect(started.error).toContain("权限被拒绝");
    expect(result.current.recording).toBe(false);
  });
});