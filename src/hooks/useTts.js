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

// 播报预算：按字数估算一个宽松上限，超过就认为播报已经卡死。
// 早先浏览器 TTS 用了 `Math.min(20000, ...)` 的硬上限，长题目会在念到一半时被判成
// “播报结束”，面试官还没问完就开始收音；这里改成只做兜底、不再设低天花板。
export function playbackBudgetMs(text) {
  return Math.max(4000, text.length * 300 + 4000);
}

// 等待音频播完：优先相信 ended 事件与真实 duration，估算值只作兜底。
function waitForPlayback(media, fallbackMs) {
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    const cleanup = () => {
      if (timer) window.clearTimeout(timer);
      timer = null;
      media.onended = null;
      media.onerror = null;
      media.onloadedmetadata = null;
    };
    const finish = () => {
      if (done) return;
      done = true;
      cleanup();
      resolve();
    };
    const arm = (ms) => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(finish, ms);
    };
    media.onended = finish;
    media.onerror = finish;
    // 元数据到达后按真实时长重新计时；拿不到 duration 就继续沿用估算值。
    media.onloadedmetadata = () => {
      const seconds = Number(media.duration);
      if (Number.isFinite(seconds) && seconds > 0) arm(seconds * 1000 + 2500);
    };
    arm(fallbackMs);
    const started = media.play();
    if (started && typeof started.catch === "function") started.catch(finish);
  });
}

// 浏览器内置 TTS 的等待：以 onend 为准，并对 iOS Safari 保活——长句经常既不来
// onend 也不报错，面试官会永远卡在“正在提问”而不再收音。
function waitForUtterance(utter, text) {
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    let keepAlive = null;
    let sawSpeaking = false;
    const stop = () => {
      if (keepAlive) window.clearInterval(keepAlive);
      keepAlive = null;
      if (timer) window.clearTimeout(timer);
      timer = null;
    };
    const finish = () => {
      if (done) return;
      done = true;
      stop();
      resolve();
    };
    utter.onend = finish;
    utter.onerror = finish;
    window.speechSynthesis.speak(utter);
    keepAlive = window.setInterval(() => {
      if (done) return;
      const synth = window.speechSynthesis;
      if (synth.speaking) {
        sawSpeaking = true;
        if (synth.paused) synth.resume();
        return;
      }
      // 只在此前确实开始播报过时才认为已经结束，避免 speak() 尚未起播就被判完成。
      if (sawSpeaking) finish();
    }, 1000);
    timer = window.setTimeout(finish, playbackBudgetMs(text));
  });
}

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
            await waitForPlayback(audio, playbackBudgetMs(text));
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
      await waitForUtterance(utter, text);
    },
    [autoSpeak, cancelSpeech, isTextModeRef, voiceName]
  );

  return { speak, cancelSpeech };
}
