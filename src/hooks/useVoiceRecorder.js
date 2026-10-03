import { useCallback, useRef, useState } from "react";

// 录音上传：给服务端 ASR 提供音频。用 MediaRecorder 录音，用 AudioContext 的 RMS 判断"是否在说话"，
// 停顿判定仍交给调用方现有的 useAnswerBuffer，因此不用改语音面试的状态机。
export function isVoiceRecordingSupported() {
  if (typeof window === "undefined") return false;
  return Boolean(window.MediaRecorder && navigator.mediaDevices?.getUserMedia);
}

const PREFERRED_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4"
];

export function pickRecorderMimeType(recorder = window.MediaRecorder) {
  if (!recorder?.isTypeSupported) return "";
  return PREFERRED_MIME_TYPES.find((type) => recorder.isTypeSupported(type)) || "";
}

export function audioExtensionFor(mimeType) {
  const map = [
    [/ogg/i, "ogg"],
    [/mp4|m4a|aac/i, "mp4"],
    [/wav/i, "wav"],
    [/mpeg|mp3/i, "mp3"],
    [/webm/i, "webm"]
  ];
  const match = map.find(([pattern]) => pattern.test(String(mimeType || "")));
  return match ? match[1] : "webm";
}

export default function useVoiceRecorder({ onLevel, levelThreshold = 0.015 } = {}) {
  const [recording, setRecording] = useState(false);
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const streamRef = useRef(null);
  const audioContextRef = useRef(null);
  const frameRef = useRef(0);
  const recordingRef = useRef(false);
  const levelCallbackRef = useRef(onLevel);
  levelCallbackRef.current = onLevel;

  const stopMeter = useCallback(() => {
    if (frameRef.current) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
    }
    if (audioContextRef.current) {
      const ctx = audioContextRef.current;
      audioContextRef.current = null;
      try {
        ctx.close();
      } catch {
        // 已经关闭
      }
    }
  }, []);

  const releaseStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  }, []);

  const stop = useCallback(async () => {
    recordingRef.current = false;
    setRecording(false);
    stopMeter();
    const recorder = recorderRef.current;
    recorderRef.current = null;
    let blob = null;
    if (recorder && recorder.state !== "inactive") {
      blob = await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          const type = recorder.mimeType || "audio/webm";
          resolve(chunksRef.current.length ? new Blob(chunksRef.current, { type }) : null);
        };
        try {
          recorder.onstop = finish;
          recorder.stop();
        } catch {
          finish();
        }
        // 兜底：个别浏览器不触发 onstop
        window.setTimeout(finish, 1500);
      });
    }
    chunksRef.current = [];
    releaseStream();
    return blob;
  }, [releaseStream, stopMeter]);

  const start = useCallback(async () => {
    if (!isVoiceRecordingSupported()) {
      return { ok: false, error: "当前浏览器不支持录音上传，请改用文字回答。" };
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true }
      });
      streamRef.current = stream;
      const mimeType = pickRecorderMimeType();
      const recorder = new window.MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size) chunksRef.current.push(event.data);
      };
      recorder.start(1000);
      recorderRef.current = recorder;
      recordingRef.current = true;
      setRecording(true);

      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        const ctx = new AudioCtx();
        audioContextRef.current = ctx;
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        ctx.createMediaStreamSource(stream).connect(analyser);
        const samples = new Uint8Array(analyser.fftSize);
        const tick = () => {
          if (!recordingRef.current) return;
          analyser.getByteTimeDomainData(samples);
          let sum = 0;
          for (let i = 0; i < samples.length; i += 1) {
            const value = (samples[i] - 128) / 128;
            sum += value * value;
          }
          const rms = Math.sqrt(sum / samples.length);
          levelCallbackRef.current?.(rms, rms > levelThreshold);
          frameRef.current = window.requestAnimationFrame(tick);
        };
        frameRef.current = window.requestAnimationFrame(tick);
      }
      return { ok: true, error: "" };
    } catch (err) {
      recordingRef.current = false;
      setRecording(false);
      releaseStream();
      const name = err?.name || "";
      const error =
        name === "NotAllowedError" || name === "PermissionDeniedError"
          ? "麦克风权限被拒绝"
          : `录音启动失败：${err?.message || err}`;
      return { ok: false, error };
    }
  }, [levelThreshold, releaseStream]);

  return { recording, recordingRef, start, stop, releaseStream };
}