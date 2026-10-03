import { useCallback, useRef, useState } from "react";

export function getSpeechRecognitionCtor() {
  if (typeof window === "undefined") return null;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

// 浏览器语音识别：负责识别实例的生命周期、自动续听与错误降级。
// 文本累积与停顿判定仍由调用方处理（通过 onResult / onRecognitionStart 回调）。
export default function useSpeechRecognition({
  finishedRef,
  phaseRef,
  setPhase,
  setStatusText,
  setSpeechError,
  setTextFallback,
  cancelSpeech,
  onResult,
  onRecognitionStart
}) {
  const [listening, setListening] = useState(false);
  const listeningRef = useRef(false);
  const recognitionRef = useRef(null);

  const stopRecognition = useCallback(() => {
    listeningRef.current = false;
    setListening(false);
    if (recognitionRef.current) {
      try {
        recognitionRef.current.onresult = null;
        recognitionRef.current.onend = null;
        recognitionRef.current.stop();
      } catch {
        // already stopped
      }
      recognitionRef.current = null;
    }
  }, []);

  const startListening = useCallback(() => {
    if (finishedRef.current) return;
    const SR = getSpeechRecognitionCtor();
    if (!SR) return;
    cancelSpeech();
    setSpeechError("");
    onRecognitionStart();
    const recognition = new SR();
    recognitionRef.current = recognition;
    recognition.lang = "zh-CN";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event) => {
      const finals = [];
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) finals.push(transcript);
        else interim += transcript;
      }
      onResult({ finals, interim });
    };
    recognition.onerror = (event) => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        setTextFallback(true);
        setSpeechError("麦克风未授权或不可用，已切换到文字回答。");
        setListening(false);
        listeningRef.current = false;
        phaseRef.current = "texting";
        setPhase("texting");
      } else if (event.error === "no-speech") {
        // no speech is handled by the buffer timer; keep waiting
      } else if (event.error === "network") {
        setSpeechError("语音识别网络异常，可继续说话或改用文字。");
      }
    };
    recognition.onend = () => {
      if (listeningRef.current && phaseRef.current === "listening" && !finishedRef.current) {
        try {
          recognition.start();
        } catch {
          // restart failure; UI can fall back to text
        }
      }
    };

    listeningRef.current = true;
    phaseRef.current = "listening";
    setPhase("listening");
    setListening(true);
    setStatusText("我在听，你按自己的节奏说，中间停顿没关系");
    try {
      recognition.start();
    } catch {
      setTextFallback(true);
      setSpeechError("语音识别启动失败，请使用文字回答。");
      phaseRef.current = "texting";
      setPhase("texting");
    }
  }, [
    cancelSpeech,
    finishedRef,
    onRecognitionStart,
    onResult,
    phaseRef,
    setPhase,
    setSpeechError,
    setStatusText,
    setTextFallback
  ]);

  return { listening, listeningRef, recognitionRef, startListening, stopRecognition };
}
