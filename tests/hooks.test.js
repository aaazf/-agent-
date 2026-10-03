import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import useCamera from "../src/hooks/useCamera.js";
import useTts from "../src/hooks/useTts.js";
import useAnswerBuffer from "../src/hooks/useAnswerBuffer.js";
import useSpeechRecognition, { getSpeechRecognitionCtor } from "../src/hooks/useSpeechRecognition.js";

function fakeStream() {
  return { getTracks: () => [{ stop: vi.fn() }] };
}

describe("useCamera", () => {
  beforeEach(() => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue(fakeStream()) }
    });
  });

  it("turns on when permission is granted", async () => {
    const { result } = renderHook(() => useCamera());
    expect(result.current.cameraOn).toBe(false);
    await act(async () => {
      await result.current.startCamera();
    });
    expect(result.current.cameraOn).toBe(true);
    expect(result.current.cameraError).toBe("");
  });

  it("reports a helpful message when permission is denied", async () => {
    navigator.mediaDevices.getUserMedia = vi.fn().mockRejectedValue(Object.assign(new Error("x"), { name: "NotAllowedError" }));
    const { result } = renderHook(() => useCamera());
    await act(async () => {
      await result.current.startCamera();
    });
    expect(result.current.cameraOn).toBe(false);
    expect(result.current.cameraError).toContain("权限被拒绝");
  });

  it("stops the stream when toggled off", async () => {
    const track = { stop: vi.fn() };
    const stream = { getTracks: () => [track] };
    navigator.mediaDevices.getUserMedia = vi.fn().mockResolvedValue(stream);
    const { result } = renderHook(() => useCamera());
    await act(async () => {
      await result.current.startCamera();
    });
    act(() => result.current.toggleCamera());
    expect(result.current.cameraOn).toBe(false);
    expect(track.stop).toHaveBeenCalled();
  });
});

describe("useTts", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
    global.URL.createObjectURL = vi.fn(() => "blob:fake");
    global.URL.revokeObjectURL = vi.fn();
    global.Audio = class {
      constructor() {
        this.play = vi.fn().mockResolvedValue();
      }
      removeAttribute() {}
      load() {}
      pause() {}
    };
  });

  it("uses Edge TTS when available", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(["x"]) });
    const isTextModeRef = { current: false };
    const { result } = renderHook(() => useTts({ autoSpeak: true, voiceName: "auto", isTextModeRef }));
    await act(async () => {
      await result.current.speak("你好");
    });
    expect(global.fetch).toHaveBeenCalledWith("/api/edge-tts", expect.objectContaining({ method: "POST" }));
  });

  it("skips speaking when autoSpeak is off or in text mode", async () => {
    const off = renderHook(() => useTts({ autoSpeak: false, voiceName: "auto", isTextModeRef: { current: false } }));
    await act(async () => {
      await off.result.current.speak("你好");
    });
    const textMode = renderHook(() => useTts({ autoSpeak: true, voiceName: "auto", isTextModeRef: { current: true } }));
    await act(async () => {
      await textMode.result.current.speak("你好");
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("getSpeechRecognitionCtor", () => {
  afterEach(() => {
    delete window.SpeechRecognition;
    delete window.webkitSpeechRecognition;
  });

  it("returns null when unsupported", () => {
    expect(getSpeechRecognitionCtor()).toBe(null);
  });

  it("prefers the standard constructor", () => {
    class A {}
    window.webkitSpeechRecognition = class B {};
    window.SpeechRecognition = A;
    expect(getSpeechRecognitionCtor()).toBe(A);
  });
});

describe("useSpeechRecognition", () => {
  let instances;

  beforeEach(() => {
    instances = [];
    window.SpeechRecognition = class {
      constructor() {
        this.start = vi.fn();
        this.stop = vi.fn();
        instances.push(this);
      }
    };
  });

  afterEach(() => {
    delete window.SpeechRecognition;
  });

  function setup(overrides = {}) {
    const callbacks = {
      setPhase: vi.fn(),
      setStatusText: vi.fn(),
      setSpeechError: vi.fn(),
      setTextFallback: vi.fn(),
      cancelSpeech: vi.fn(),
      onResult: vi.fn(),
      onRecognitionStart: vi.fn(),
      ...overrides
    };
    const hook = renderHook(() =>
      useSpeechRecognition({
        finishedRef: { current: false },
        phaseRef: { current: "awaiting" },
        ...callbacks
      })
    );
    return { hook, callbacks };
  }

  it("starts listening and marks the phase", () => {
    const { hook, callbacks } = setup();
    act(() => hook.result.current.startListening());
    expect(instances).toHaveLength(1);
    expect(instances[0].start).toHaveBeenCalled();
    expect(hook.result.current.listening).toBe(true);
    expect(callbacks.setPhase).toHaveBeenCalledWith("listening");
    expect(callbacks.onRecognitionStart).toHaveBeenCalled();
  });

  it("forwards finals and interim transcripts", () => {
    const { hook, callbacks } = setup();
    act(() => hook.result.current.startListening());
    act(() => {
      instances[0].onresult({
        resultIndex: 0,
        results: [
          [{ transcript: "第一句" }],
          [{ transcript: "第二句" }]
        ].map((r, i) => Object.assign(r, { isFinal: i === 0 }))
      });
    });
    expect(callbacks.onResult).toHaveBeenCalledWith({ finals: ["第一句"], interim: "第二句" });
  });

  it("auto-restarts while still listening", () => {
    const { hook } = setup();
    act(() => hook.result.current.startListening());
    act(() => instances[0].onend());
    expect(instances[0].start).toHaveBeenCalledTimes(2);
  });

  it("falls back to text when the mic is not allowed", () => {
    const { hook, callbacks } = setup();
    act(() => hook.result.current.startListening());
    act(() => instances[0].onerror({ error: "not-allowed" }));
    expect(callbacks.setTextFallback).toHaveBeenCalledWith(true);
    expect(callbacks.setPhase).toHaveBeenCalledWith("texting");
    expect(hook.result.current.listening).toBe(false);
  });

  it("stops without restarting after stopRecognition", () => {
    const { hook } = setup();
    act(() => hook.result.current.startListening());
    act(() => hook.result.current.stopRecognition());
    expect(hook.result.current.listening).toBe(false);
    expect(instances[0].stop).toHaveBeenCalled();
  });
});

describe("useAnswerBuffer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup({ bufferEnabled = true, bufferSeconds = 3, started = true, startOffsetMs = 0 } = {}) {
    const refs = {
      settingsRef: { current: { bufferEnabled, bufferSeconds } },
      startedSpeechRef: { current: started },
      lastSpeechAtRef: { current: Date.now() - startOffsetMs },
      submittingRef: { current: false },
      finishedRef: { current: false },
      bufferActiveRef: { current: false },
      pauseCountRef: { current: 0 },
      submitAnswerRef: { current: vi.fn() },
      setPauseCount: vi.fn(),
      setBufferSeconds: vi.fn(),
      setBufferState: vi.fn()
    };
    renderHook(() => useAnswerBuffer({ active: true, ...refs }));
    return refs;
  }

  it("counts a pause exactly once per silence window", () => {
    const refs = setup({ bufferSeconds: 3 });
    act(() => vi.advanceTimersByTime(3500));
    expect(refs.pauseCountRef.current).toBe(1);
    act(() => vi.advanceTimersByTime(3000));
    expect(refs.pauseCountRef.current).toBe(1);
  });

  it("auto-submits after threshold + 5s", () => {
    const refs = setup({ bufferSeconds: 3 });
    act(() => vi.advanceTimersByTime(8000));
    expect(refs.submitAnswerRef.current).toHaveBeenCalled();
  });

  it("does not auto-submit before the window closes", () => {
    const refs = setup({ bufferSeconds: 3 });
    act(() => vi.advanceTimersByTime(2000));
    expect(refs.submitAnswerRef.current).not.toHaveBeenCalled();
  });

  it("uses a 2s threshold when buffering is disabled", () => {
    const refs = setup({ bufferEnabled: false });
    act(() => vi.advanceTimersByTime(2500));
    expect(refs.pauseCountRef.current).toBe(1);
    act(() => vi.advanceTimersByTime(5000));
    expect(refs.submitAnswerRef.current).toHaveBeenCalled();
  });

  it("resets the buffer when speech resumes", () => {
    const refs = setup({ bufferSeconds: 3 });
    act(() => vi.advanceTimersByTime(3500));
    expect(refs.bufferActiveRef.current).toBe(true);
    refs.lastSpeechAtRef.current = Date.now();
    act(() => vi.advanceTimersByTime(1000));
    expect(refs.bufferActiveRef.current).toBe(false);
  });

  it("waits quietly when the candidate has not started speaking", () => {
    const refs = setup({ started: false, startOffsetMs: 25000 });
    act(() => vi.advanceTimersByTime(1500));
    expect(refs.pauseCountRef.current).toBe(0);
    expect(refs.setBufferState).toHaveBeenCalled();
  });
});
