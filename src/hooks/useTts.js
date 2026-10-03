import { useCallback, useRef } from "react";

const EDGE_VOICE_MAP = {
  XiaoxiaoNeural: "zh-CN-XiaoxiaoNeural",
  XiaoyiNeural: "zh-CN-XiaoyiNeural",
  YunxiNeural: "zh-CN-YunxiNeural",
  YunjianNeural: "zh-CN-YunjianNeural",
  YunyangNeural: "zh-CN-YunyangNeural"
};

const PREFERRED_VOICES = [
  "zh-CN-XiaoxiaoNeural",
  "XiaoxiaoNeural",
  "zh-CN-YunxiNeural",
  "YunxiNeural",
  "zh-CN-XiaoyiNeural",
  "XiaoyiNeural",
  "zh-CN-YunjianNeural",
  "YunjianNeural"
];

// 语音播报：优先本地 Edge TTS（更自然的音色），失败时回退浏览器 speechSynthesis。
// isTextModeRef 用 ref 传入，避免 useCallback 闭包读到过期的模式状态。
export default function useTts({ autoSpeak, voiceName, isTextModeRef }) {
  const edgeAudioRef = useRef(null);
  // 服务端没有 edge-tts 时永久跳过，被限流时只跳过一小段时间，避免每次播报都白等一次失败请求。
  const edgeBlockedUntilRef = useRef(0);

  const cancelSpeech = useCallback(() => {
    if (edgeAudioRef.current) {
      try {
        edgeAudioRef.current.pause();
        edgeAudioRef.current.removeAttribute("src");
        edgeAudioRef.current.load();
      } catch {
        // audio cleanup
      }
      edgeAudioRef.current = null;
    }
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
  }, []);

  const speak = useCallback(
    async (text) => {
      if (!autoSpeak || isTextModeRef.current) {
        return;
      }
      cancelSpeech();
      const voiceKey = voiceName === "auto" ? "XiaoxiaoNeural" : voiceName;
      const naturalVoice = EDGE_VOICE_MAP[voiceKey];
      const edgeUsable = Date.now() >= edgeBlockedUntilRef.current;
      if (naturalVoice && !voiceName?.startsWith("system") && edgeUsable) {
        try {
          const ttsResp = await fetch("/api/edge-tts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              text,
              voice: naturalVoice,
              rate: "+5%",
              pitch: "+0Hz"
            })
          });
          if (ttsResp.ok) {
            const audioBlob = await ttsResp.blob();
            const url = URL.createObjectURL(audioBlob);
            const audio = new Audio(url);
            edgeAudioRef.current = audio;
            await new Promise((resolve) => {
              let done = false;
              const finish = () => {
                if (!done) {
                  done = true;
                  resolve();
                }
              };
              audio.onended = finish;
              audio.onerror = finish;
              audio.play().catch(finish);
              window.setTimeout(finish, Math.max(3000, text.length * 260 + 3000));
            });
            URL.revokeObjectURL(url);
            edgeAudioRef.current = null;
            return;
          } else if (ttsResp.status === 501 || ttsResp.status === 503) {
            edgeBlockedUntilRef.current = Number.POSITIVE_INFINITY;
          } else if (ttsResp.status === 429) {
            edgeBlockedUntilRef.current = Date.now() + 60_000;
          }
        } catch {
          // fall through to browser speech
        }
      }
      if (!("speechSynthesis" in window)) return;
      let voices = window.speechSynthesis.getVoices();
      if (!voices.length) {
        await new Promise((resolve) => {
          let settled = false;
          const done = () => {
            if (!settled) {
              settled = true;
              resolve();
            }
          };
          window.speechSynthesis.onvoiceschanged = done;
          window.setTimeout(done, 1400);
        });
        voices = window.speechSynthesis.getVoices();
      }

      const zhVoices = voices.filter((voice) => voice.lang && voice.lang.toLowerCase().startsWith("zh"));
      let voice = null;
      if (voiceName && voiceName !== "auto" && voiceName !== "system") {
        voice = voices.find((item) => item.name.includes(voiceName)) || null;
      }
      if (!voice) {
        voice = zhVoices.find((item) => PREFERRED_VOICES.some((name) => item.name.includes(name))) || zhVoices[0] || null;
      }

      const utter = new SpeechSynthesisUtterance(text);
      utter.lang = voice?.lang || "zh-CN";
      utter.rate = voiceName === "system" ? 1 : 0.98;
      utter.pitch = 1;
      if (voice) utter.voice = voice;
      await new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (!done) {
            done = true;
            resolve();
          }
        };
        utter.onend = finish;
        utter.onerror = finish;
        window.speechSynthesis.speak(utter);
        window.setTimeout(finish, Math.max(2500, Math.min(20000, text.length * 220 + 1800)));
      });
    },
    [autoSpeak, cancelSpeech, isTextModeRef, voiceName]
  );

  return { speak, cancelSpeech };
}
