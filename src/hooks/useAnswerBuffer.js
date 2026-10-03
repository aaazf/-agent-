import { useEffect } from "react";

// 停顿缓冲定时器：只在进入 listening 时建立一次，内部通过 ref 读取最新状态，
// 不会因为 bufferActive / 设置变化被反复重建，避免计时与暂停计数错乱。
export default function useAnswerBuffer({
  active,
  settingsRef,
  startedSpeechRef,
  lastSpeechAtRef,
  submittingRef,
  finishedRef,
  bufferActiveRef,
  pauseCountRef,
  setPauseCount,
  setBufferSeconds,
  setBufferState,
  submitAnswerRef
}) {
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => {
      if (submittingRef.current || finishedRef.current) return;
      const now = Date.now();
      if (!startedSpeechRef.current) {
        const waiting = Math.floor((now - lastSpeechAtRef.current) / 1000);
        if (waiting > 20) setBufferState(true, waiting);
        return;
      }
      const silent = Math.floor((now - lastSpeechAtRef.current) / 1000);
      const { bufferEnabled, bufferSeconds } = settingsRef.current;
      const silenceThreshold = bufferEnabled ? bufferSeconds : 2;
      if (silent >= silenceThreshold) {
        if (!bufferActiveRef.current) {
          pauseCountRef.current += 1;
          setPauseCount((count) => count + 1);
          // 由 hook 自己维护 ref，避免调用方的 setBufferState 忘记同步 ref 时状态错乱。
          bufferActiveRef.current = true;
          setBufferState(true, silent);
        } else {
          setBufferSeconds(silent);
        }
        if (silent >= silenceThreshold + 5) {
          submitAnswerRef.current?.();
        }
      } else if (bufferActiveRef.current) {
        bufferActiveRef.current = false;
        setBufferState(false);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [
    active,
    bufferActiveRef,
    finishedRef,
    lastSpeechAtRef,
    pauseCountRef,
    setBufferSeconds,
    setBufferState,
    setPauseCount,
    settingsRef,
    startedSpeechRef,
    submitAnswerRef,
    submittingRef
  ]);
}
