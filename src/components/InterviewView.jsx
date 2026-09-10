import { useCallback, useEffect, useRef, useState } from "react";
import {
  AudioLines,
  Bot,
  Camera,
  CameraOff,
  Check,
  ChevronLeft,
  CircleStop,
  Clock3,
  FileText,
  Lightbulb,
  LoaderCircle,
  MessageSquareText,
  Mic,
  MicOff,
  Play,
  RotateCcw,
  Send,
  Sparkles,
  Video,
  X,
  Zap
} from "lucide-react";
import { callModel, generateInterviewerDecision, buildEvaluateMessages, extractJson } from "../lib/model.js";
import { localQuestion } from "../lib/questions.js";
import { localEvaluation, normalizeModelEvaluation } from "../lib/evaluate.js";
import { addResult, uid } from "../lib/storage.js";

function cleanModelQuestion(raw) {
  const cleaned = String(raw || "")
    .replace(/^["'“”\s]+/, "")
    .replace(/["'“”\s]+$/, "")
    .replace(/^(面试官|问题|下一题|追问|好的|好)[:：]?\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  const line = cleaned.split(/\n{2,}/)[0] || cleaned;
  return line.slice(0, 260);
}

export default function InterviewView({ settings, onFinish, onExit }) {
  const [phase, setPhase] = useState("starting");
  const [statusText, setStatusText] = useState("准备本场面试");
  const [history, setHistory] = useState([]);
  const [currentQuestion, setCurrentQuestion] = useState(null);
  const [liveAnswer, setLiveAnswer] = useState("");
  const [textAnswer, setTextAnswer] = useState("");
  const [speechAvailable, setSpeechAvailable] = useState(
    Boolean(window.SpeechRecognition || window.webkitSpeechRecognition)
  );
  const [speechError, setSpeechError] = useState("");
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraStarting, setCameraStarting] = useState(false);
  const [cameraError, setCameraError] = useState("");
  const [micCheck, setMicCheck] = useState("idle");
  const [micCheckMsg, setMicCheckMsg] = useState("");
  const [listening, setListening] = useState(false);
  const [bufferActive, setBufferActive] = useState(false);
  const [bufferSeconds, setBufferSeconds] = useState(0);
  const [pauseCount, setPauseCount] = useState(0);
  const [hintsUsed, setHintsUsed] = useState(0);
  const [sourceNote, setSourceNote] = useState("");
  const [earlyEnding, setEarlyEnding] = useState(false);
  const [textFallback, setTextFallback] = useState(false);

  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const cameraBusyRef = useRef(false);
  const submittingRef = useRef(false);
  const recognitionRef = useRef(null);
  const listeningRef = useRef(false);
  const phaseRef = useRef("starting");
  const liveRef = useRef("");
  const lastSpeechAtRef = useRef(Date.now());
  const startedSpeechRef = useRef(false);
  const finishedRef = useRef(false);
  const historyRef = useRef([]);
  const currentQuestionRef = useRef(null);
  const questionStartRef = useRef(Date.now());
  const sessionStartRef = useRef(Date.now());
  const pauseCountRef = useRef(0);
  const edgeAudioRef = useRef(null);

  const updateHistory = (next) => {
    historyRef.current = next;
    setHistory(next);
  };

  const setLive = (value) => {
    liveRef.current = value;
    setLiveAnswer(value);
  };

  const isTextMode = settings.interviewMode === "text" || textFallback;

  async function startSession() {
    if (settings.cameraOn && !cameraOn && !cameraStarting) startCamera();
    let forceText = false;
    if (settings.interviewMode === "voice" && navigator.mediaDevices?.getUserMedia) {
      try {
        const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
        mic.getTracks().forEach((track) => track.stop());
      } catch {
        forceText = true;
        setTextFallback(true);
        setSpeechError("无法获得麦克风权限，本场已自动切换为文字面试。");
      }
    }
    await askQuestion({ nextHistory: [], mode: "first", forceText });
  }

  function stopRecognition() {
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
  }

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
      if (!settings.autoSpeak || isTextMode) {
        return;
      }
      cancelSpeech();
      const edgeVoiceMap = {
        XiaoxiaoNeural: "zh-CN-XiaoxiaoNeural",
        XiaoyiNeural: "zh-CN-XiaoyiNeural",
        YunxiNeural: "zh-CN-YunxiNeural",
        YunjianNeural: "zh-CN-YunjianNeural",
        YunyangNeural: "zh-CN-YunyangNeural"
      };
      const voiceKey = settings.voiceName === "auto" ? "XiaoxiaoNeural" : settings.voiceName;
      const naturalVoice = edgeVoiceMap[voiceKey];
      if (naturalVoice && !settings.voiceName?.startsWith("system")) {
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
      const preferredNames = [
        "zh-CN-XiaoxiaoNeural",
        "XiaoxiaoNeural",
        "zh-CN-YunxiNeural",
        "YunxiNeural",
        "zh-CN-XiaoyiNeural",
        "XiaoyiNeural",
        "zh-CN-YunjianNeural",
        "YunjianNeural"
      ];
      let voice = null;
      if (settings.voiceName && settings.voiceName !== "auto" && settings.voiceName !== "system") {
        voice = voices.find((item) => item.name.includes(settings.voiceName)) || null;
      }
      if (!voice) {
        voice =
          zhVoices.find((item) => preferredNames.some((name) => item.name.includes(name))) ||
          zhVoices[0] ||
          null;
      }

      const utter = new SpeechSynthesisUtterance(text);
      utter.lang = voice?.lang || "zh-CN";
      utter.rate = settings.voiceName === "system" ? 1 : 0.98;
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
    [cancelSpeech, settings.autoSpeak, settings.voiceName]
  );

  async function startCamera() {
    if (cameraBusyRef.current) return;
    cameraBusyRef.current = true;
    setCameraStarting(true);
    setCameraError("");
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError("当前浏览器不支持摄像头");
      setCameraStarting(false);
      cameraBusyRef.current = false;
      return;
    }
    try {
      stopCameraStream();
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
        audio: false
      });
      streamRef.current = stream;
      setCameraOn(true);
      setCameraError("");
      setCameraStarting(false);
    } catch (err) {
      setCameraOn(false);
      const name = err?.name || "";
      if (name === "NotAllowedError" || name === "PermissionDeniedError") {
        setCameraError("摄像头权限被拒绝：请在浏览器地址栏允许摄像头权限后，再点“重试开启摄像头”。");
      } else if (name === "NotFoundError" || name === "DevicesNotFoundError") {
        setCameraError("没有检测到可用摄像头；可以插好摄像头后重试，语音面试不受影响。");
      } else {
        setCameraError("摄像头暂时无法打开，可稍后点“重试开启摄像头”，或直接继续语音面试。");
      }
      setCameraStarting(false);
    } finally {
      cameraBusyRef.current = false;
    }
  }

  function stopCameraStream() {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  }

  useEffect(() => {
    if (cameraOn && streamRef.current && videoRef.current) {
      videoRef.current.srcObject = streamRef.current;
      videoRef.current.play().catch(() => {});
    }
  }, [cameraOn]);

  function toggleCamera() {
    if (cameraOn) {
      stopCameraStream();
      setCameraOn(false);
      if (videoRef.current) videoRef.current.srcObject = null;
    } else {
      startCamera();
    }
  }

  async function checkMicrophone() {
    setMicCheck("loading");
    setMicCheckMsg("");
    if (!navigator.mediaDevices?.getUserMedia) {
      setMicCheck("error");
      setMicCheckMsg("当前浏览器不支持麦克风");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      window.setTimeout(() => {
        stream.getTracks().forEach((track) => track.stop());
      }, 1200);
      setMicCheck("ok");
      setMicCheckMsg("麦克风正常，可以开始语音面试");
    } catch (err) {
      setMicCheck("error");
      setMicCheckMsg("麦克风不可用或权限被拒绝，可先点“允许麦克风”再重试");
    }
  }

  async function askQuestion({ nextHistory, mode = "next", forceText = false, forceLocal = false }) {
    if (finishedRef.current) return;
    phaseRef.current = "thinking";
    setPhase("thinking");
    setStatusText(mode === "first" ? "我先看看你的简历和岗位，给你准备一个合适的开头" : "我听到你刚才的回答了，先想一下接下来怎么问更合适");
    setBufferActive(false);
    setBufferSeconds(0);
    startedSpeechRef.current = false;

    let question;
    if (!forceLocal && settings.modelEnabled && settings.apiKey.trim()) {
      try {
        const decision = await generateInterviewerDecision({ settings, history: nextHistory });
        const focusMap = {
          followup: "针对回答追问",
          new_dimension: "切换新维度",
          probe: "深挖验证",
          wrap: "收束话题"
        };
        question = {
          text: decision.text,
          focus: focusMap[decision.type] || "模型动态出题",
          source: "model",
          decisionType: decision.type,
          understanding: decision.understanding,
          strategy: decision.strategy
        };
        setSourceNote(`${settings.modelName} 理解回答后决策：${decision.type}`);
      } catch {
        question = localQuestion(settings, nextHistory.length);
        setSourceNote("模型调用失败，已切到本地题库兜底");
      }
    } else {
      question = localQuestion(settings, nextHistory.length);
      setSourceNote(forceLocal ? "本轮先不追问，换一个更容易展开的问题" : "未配置模型 API，使用本地题库");
    }

    if (finishedRef.current) return;
    currentQuestionRef.current = question;
    setCurrentQuestion(question);
    questionStartRef.current = Date.now();
    setLive("");
    setTextAnswer("");
    liveRef.current = "";
    setSpeechError("");
    setStatusText("我先把问题慢慢说给你听");
    phaseRef.current = "speaking";
    setPhase("speaking");
    await speak(question.text);
    if (finishedRef.current) return;
    if (isTextMode || forceText) {
      phaseRef.current = "texting";
      setPhase("texting");
      setStatusText("请直接输入回答，按 Enter 发送；发送后我会根据回答继续提问");
    } else {
      phaseRef.current = "listening";
      setPhase("listening");
      setStatusText("我在听，你说完停顿几秒，我会自动识别并进入下一题");
      startListening();
    }
  }

  function handleRecognitionResult(event) {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        setLive((prev) => {
          const next = `${prev}${transcript}`;
          liveRef.current = next;
          return next;
        });
      } else {
        interim += transcript;
      }
    }
    if (interim) {
      setLiveAnswer(`${liveRef.current}${interim}`.trim());
    }
    lastSpeechAtRef.current = Date.now();
    startedSpeechRef.current = true;
    setBufferActive(false);
    setBufferSeconds(0);
  }

  function startListening() {
    if (finishedRef.current) return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      setSpeechError("当前浏览器不支持语音识别，请直接使用文字回答。");
      skipToText();
      return;
    }
    cancelSpeech();
    setSpeechError("");
    startedSpeechRef.current = false;
    lastSpeechAtRef.current = Date.now();
    const recognition = new SR();
    recognitionRef.current = recognition;
    recognition.lang = "zh-CN";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onresult = handleRecognitionResult;
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
  }

  function skipToText() {
    stopRecognition();
    setTextFallback(true);
    phaseRef.current = "texting";
    setPhase("texting");
    setStatusText("文字回答模式，输入后发送即可");
  }

  async function submitAnswer({ skip = false } = {}) {
    if (submittingRef.current) return;
    submittingRef.current = true;
    const answer = (liveRef.current || textAnswer).trim();
    if (!answer && !skip) {
      setStatusText("如果还没想好也没关系，可以先要个提示，或输入一点想法再继续。");
      submittingRef.current = false;
      return;
    }
    stopRecognition();
    cancelSpeech();
    const question = currentQuestionRef.current;
    if (!question) {
      submittingRef.current = false;
      return;
    }
    const round = {
      question: question.text,
      focus: question.focus,
      answer: skip ? "" : answer,
      source: question.source,
      durationMs: Date.now() - questionStartRef.current,
      pauseCount: pauseCountRef.current,
      usedHint: hintsUsed > 0
    };
    const nextHistory = [...historyRef.current, round];
    const forceLocal = Boolean(
      answer &&
      (/^(不知道|不清楚|不会|没学过|没接触过|忘了|想不起来|跳过)/.test(answer) || answer.length < 6)
    );
    pauseCountRef.current = 0;
    setPauseCount(0);
    updateHistory(nextHistory);
    setLive("");
    setTextAnswer("");
    liveRef.current = "";
    setBufferActive(false);

    if (nextHistory.length >= settings.questionCount) {
      await finishInterview(nextHistory);
      return;
    }
    submittingRef.current = false;
    await askQuestion({ nextHistory, forceLocal });
  }

  function askHint() {
    const hints = {
      自我介绍: "把回答压成：我是谁 + 与岗位最相关的 2 点能力 + 最近一段相关经历 + 为什么想来。",
      项目深挖: "按 STAR 讲：背景与目标、你的职责、具体动作、可量化结果与复盘。",
      岗位匹配: "先说三点匹配，再坦诚讲一个真实差距，并给出补足动作，避免只列优点。",
      场景应变: "先说处理原则（止血-定位-修复-复盘），再用具体动作和时间线展开。",
      行为面试: "挑一次真实经历，讲清当时目标、你的选择、结果和你后来的改变。",
      反问环节: "可以问团队如何衡量结果、新人如何上手、当前最大的技术或业务挑战。",
      综合考察: "先给一句话结论，再分 2-3 点展开，最后收束到你的经历或学习计划。",
      模型动态出题: "不用怕停顿，先把想到的关键词说出来，再补完整句子；想好后点“我说完了”。"
    };
    const hint = hints[currentQuestionRef.current?.focus] || hints["综合考察"];
    setTextAnswer((prev) => (prev ? `${prev}\n\n提示：${hint}` : `提示：${hint}`));
    setHintsUsed((count) => count + 1);
    setStatusText("已给出提示词，可在此基础上继续补充");
  }

  async function finishInterview(nextHistory) {
    if (finishedRef.current) return;
    finishedRef.current = true;
    stopRecognition();
    cancelSpeech();
    phaseRef.current = "ending";
    setPhase("ending");
    setStatusText("面试到这里结束了，我先帮你整理一份温和、真实的复盘");

    const fallback = localEvaluation({
      settings,
      history: nextHistory,
      stats: {
        pauses: pauseCountRef.current + historyRef.current.reduce((sum, r) => sum + (r.pauseCount || 0), 0),
        hintsUsed
      }
    });

    let evaluation = fallback;
    if (settings.modelEnabled && settings.apiKey.trim()) {
      try {
        const raw = await callModel({
          settings,
          messages: buildEvaluateMessages({ settings, history: nextHistory })
        });
        const parsed = extractJson(raw);
        evaluation = normalizeModelEvaluation(parsed, fallback);
      } catch {
        evaluation = fallback;
      }
    }

    const totalPauses = nextHistory.reduce((sum, r) => sum + (r.pauseCount || 0), 0);
    const result = {
      id: uid(),
      createdAt: Date.now(),
      settings: {
        role: settings.role,
        direction: settings.direction,
        style: settings.style,
        resume: settings.resume,
        jd: settings.jd,
        questionCount: settings.questionCount,
        modelName: settings.apiKey.trim() ? settings.modelName : ""
      },
      history: nextHistory,
      evaluation,
      stats: {
        durationMs: Date.now() - sessionStartRef.current,
        pauseCount: totalPauses,
        hintsUsed,
        modelUsed: nextHistory.some((r) => r.source === "model"),
        earlyEnded: nextHistory.length < settings.questionCount
      },
      cameraUsed: cameraOn
    };
    addResult(result);
    onFinish(result);
  }

  const endEarly = async () => {
    setEarlyEnding(true);
    const answer = (liveRef.current || textAnswer).trim();
    let nextHistory = historyRef.current;
    if (answer && currentQuestionRef.current) {
      nextHistory = [
        ...nextHistory,
        {
          question: currentQuestionRef.current.text,
          answer,
          durationMs: Date.now() - questionStartRef.current,
          pauseCount: pauseCountRef.current,
          usedHint: hintsUsed > 0
        }
      ];
      updateHistory(nextHistory);
    }
    await finishInterview(nextHistory);
  };

  const repeatQuestion = async () => {
    if (!currentQuestionRef.current) return;
    setStatusText("重新朗读当前题目");
    await speak(currentQuestionRef.current.text);
    setStatusText("我再读一遍题目，你慢慢听");
  };

  useEffect(() => {
    sessionStartRef.current = Date.now();
    if (settings.cameraOn) startCamera();
    if (settings.interviewMode !== "text") {
      phaseRef.current = "ready";
      setPhase("ready");
      setStatusText("准备好后点击开始，进入自动听答的语音面试");
    } else {
      askQuestion({ nextHistory: [], mode: "first" });
    }
    return () => {
      finishedRef.current = true;
      stopRecognition();
      cancelSpeech();
      stopCameraStream();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (phase !== "listening") return undefined;
    const timer = setInterval(() => {
      if (submittingRef.current || finishedRef.current) return;
      if (!startedSpeechRef.current) {
        const waiting = Math.floor((Date.now() - lastSpeechAtRef.current) / 1000);
        if (waiting > 20) {
          setBufferActive(true);
          setBufferSeconds(waiting);
        }
        return;
      }
      const silent = Math.floor((Date.now() - lastSpeechAtRef.current) / 1000);
      const silenceThreshold = settings.bufferEnabled ? settings.bufferSeconds : 2;
      if (silent >= silenceThreshold) {
        if (!bufferActive) {
          pauseCountRef.current += 1;
          setPauseCount((count) => count + 1);
        }
        setBufferActive(true);
        setBufferSeconds(silent);
        if (silent >= silenceThreshold + 5) {
          submitAnswer();
        }
      } else {
        setBufferActive(false);
        setBufferSeconds(0);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [phase, bufferActive, settings.bufferSeconds, settings.bufferEnabled]);

  const canStart = phase === "awaiting" || phase === "texting" || phase === "listening";
  const completedRounds = history.length;
  const currentNumber = Math.min(completedRounds + 1, settings.questionCount);

  return (
    <div className="view interview-view">
      <header className="interview-header">
        <div className="interview-brand">
          <span className="live-dot" />
          <div>
            <b>{settings.role} · 模拟面试中</b>
            <small>
              {settings.direction} / {settings.style}
            </small>
          </div>
        </div>
        <div className="round-meta">
          <span>
            进度 {Math.min(completedRounds, settings.questionCount)} / {settings.questionCount}
          </span>
          <span className="source-badge">{sourceNote || (settings.apiKey ? "模型驱动提问" : "本地题库")}</span>
        </div>
        <button className="small-btn subtle" onClick={onExit}>
          <X size={15} />
          退出
        </button>
      </header>

      {phase === "ready" && !isTextMode ? (
        <section className="voice-ready-panel">
          <div className="voice-ready-mark">
            <Mic size={26} />
          </div>
          <div>
            <h3>面对面实时语音面试</h3>
            <p>面试官说完问题后会自动开始听你回答，你说完停顿几秒，系统会自动识别并继续提问。面试过程中不会显示任何评分。</p>
            <div className="ready-device-checks">
              <button type="button" className="small-btn" onClick={checkMicrophone} disabled={micCheck === "loading"}>
                {micCheck === "loading" ? <LoaderCircle className="spin" size={14} /> : <Mic size={14} />}
                {micCheck === "ok" ? "麦克风已就绪" : "检测麦克风"}
              </button>
              <button
                type="button"
                className="small-btn"
                onClick={() => !cameraOn && startCamera()}
                disabled={cameraOn || cameraStarting}
              >
                {cameraOn ? <Check size={14} /> : cameraStarting ? <LoaderCircle className="spin" size={14} /> : <Camera size={14} />}
                {cameraOn ? "摄像头已就绪" : cameraStarting ? "正在检测摄像头…" : "检测摄像头"}
              </button>
              {micCheckMsg ? <span className={`device-check-msg ${micCheck}`}>{micCheckMsg}</span> : null}
            </div>
          </div>
          <button className="primary-btn wide ready-start-btn" onClick={startSession}>
            <Mic size={18} />
            点击开始语音面试
          </button>
        </section>
      ) : null}

      <div className={isTextMode ? "stage-grid text-layout" : "stage-grid"}>
        <section className="stage-card interviewer-stage">
          <div className="stage-title">
            <Bot size={17} />
            AI 面试官
          </div>
          <div className={`avatar-orb phase-${phase}`}>
            <AudioLines size={34} />
            <span />
          </div>
          <div className={`interview-status status-${phase}`}>
            <span className="status-pulse" />
            <div>
              <b>{statusText}</b>
              <small>{sourceNote || (settings.modelEnabled && settings.apiKey ? `提问引擎：${settings.modelName}` : "本地兜底出题")}</small>
            </div>
          </div>
          {currentQuestion ? (
            <div className="question-card">
              <div className="question-kicker">
                第 {currentNumber} 题 · {currentQuestion.focus}
              </div>
              <p>{currentQuestion.text}</p>
            </div>
          ) : null}
          {speechError ? <div className="error-strip">{speechError}</div> : null}
        </section>

        {isTextMode ? (
          <section className="stage-card text-transcript-panel">
            <div className="stage-title">
              <MessageSquareText size={17} />
              对话记录
            </div>
            {history.length ? (
              <div className="text-dialogue">
                {history.map((round, index) => (
                  <div className="dialogue-row" key={`${round.question}-${index}`}>
                    <div className="dialogue-q">
                      <span>面试官</span>
                      <p>{round.question}</p>
                    </div>
                    <div className="dialogue-a">
                      <span>你的回答</span>
                      <p>{round.answer || "本轮未作答"}</p>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-dialogue-empty">
                第一题已经显示在左侧，直接在下方输入回答并按 Enter 发送。
              </div>
            )}
          </section>
        ) : (
          <section className="stage-card candidate-stage">
            <div className="stage-title">
              <Video size={17} />
              候选人画面
            </div>
            <div className={`camera-frame ${cameraOn ? "" : "camera-off"}`}>
              {cameraOn ? (
                <video ref={videoRef} autoPlay muted playsInline />
              ) : cameraStarting ? (
                <div className="camera-placeholder">
                  <LoaderCircle className="spin" size={28} />
                  <span>正在请求摄像头权限…</span>
                </div>
              ) : (
                <div className="camera-placeholder">
                  <Camera size={30} />
                  <span>摄像头已关闭，语音面试不受影响</span>
                </div>
              )}
            </div>
            {cameraError ? <div className="error-strip small">{cameraError}</div> : null}
            <button className="outline-btn" onClick={toggleCamera} disabled={cameraStarting}>
              {cameraOn ? <CameraOff size={15} /> : cameraStarting ? <LoaderCircle className="spin" size={15} /> : <Camera size={15} />}
              {cameraOn ? "关闭摄像头" : cameraStarting ? "正在开启…" : cameraError ? "重试开启摄像头" : "开启摄像头"}
            </button>
          </section>
        )}
      </div>

      <section className="answer-panel">
        {isTextMode ? (
          <div className="text-mode-note">
            <MessageSquareText size={16} />
            文字面试模式：面试官会等你输入完整回答，按 Enter 后继续下一问。
          </div>
        ) : (
          <div className={`buffer-rail ${bufferActive ? "buffer-on" : ""}`}>
            <div className="buffer-icon">
              {bufferActive ? <Clock3 size={17} /> : <Zap size={17} />}
            </div>
            <div className="buffer-copy">
              <b>{bufferActive ? `不催你 · 我还在听（已停 ${bufferSeconds} 秒）` : listening ? "聆听中 · 停顿会被理解" : "准备好了随时开始"}</b>
              <span>
                {settings.bufferEnabled
                  ? "如果你已经说完，我会自动识别并准备下一题；想继续补充就直接说，我会继续听。"
                  : "缓冲已关闭，说完请点“我说完了”。"}
              </span>
            </div>
            <div className="pause-counter">
              <span>本场缓冲</span>
              <b>{pauseCount}</b>
            </div>
          </div>
        )}

        <div className="answer-layout">
          <div className="answer-area">
            <label className="transcript-label">
              <span>
                {isTextMode ? <MessageSquareText size={14} /> : listening ? <MicOff size={14} /> : <Mic size={14} />}
                你的回答
              </span>
              <small>
                {isTextMode
                  ? "文字输入"
                  : listening
                    ? "正在识别…"
                    : phase === "listening"
                      ? "聆听结束"
                      : "可输入或直接说话"}
              </small>
            </label>
            <textarea
              value={textAnswer || liveAnswer}
              onChange={(e) => {
                setTextAnswer(e.target.value);
                if (e.target.value) startedSpeechRef.current = true;
              }}
              placeholder={
                isTextMode
                  ? "输入你的回答，按 Enter 发送。面试官会根据内容继续提问。"
                  : "语音识别会自动出现在这里；也可以输入文字，Ctrl+Enter 发送。"
              }
              rows={6}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey || isTextMode)) {
                  e.preventDefault();
                  submitAnswer();
                }
              }}
            />
            {!isTextMode && !speechAvailable ? (
              <div className="inline-warning">当前浏览器没有语音识别 API，请使用文字模式。</div>
            ) : null}
          </div>

          <div className="answer-controls">
            {phase === "texting" && isTextMode ? (
              <button
                className="primary-btn answer-btn"
                onClick={() => submitAnswer()}
                disabled={!textAnswer.trim() || phase === "ending"}
              >
                <Send size={19} />
                发送回答
              </button>
            ) : null}

            {phase === "awaiting" || phase === "listening" ? (
              <>
                <button
                  className="primary-btn answer-btn"
                  onClick={listening ? () => submitAnswer() : startListening}
                  disabled={phase === "ending"}
                >
                  {listening ? <Check size={19} /> : <Mic size={19} />}
                  {listening ? "我说完了" : "开始回答"}
                </button>
                {listening ? (
                  <button className="outline-btn" onClick={skipToText}>
                    <FileText size={15} />
                    改用文字
                  </button>
                ) : null}
                {!listening && (liveAnswer || textAnswer) ? (
                  <button className="outline-btn" onClick={() => submitAnswer()}>
                    <Send size={15} />
                    发送文字
                  </button>
                ) : null}
                <button className="ghost-btn" onClick={askHint}>
                  <Lightbulb size={15} />
                  要提示
                </button>
                <button className="ghost-btn" onClick={repeatQuestion}>
                  <RotateCcw size={15} />
                  重听题目
                </button>
              </>
            ) : null}

            {phase === "thinking" ? (
              <div className="model-thinking">
                <Sparkles className="spin" size={20} />
                <b>我在想怎么问更贴近你的经历</b>
                <span>会结合简历项目和你刚才的回答来选择下一问</span>
              </div>
            ) : null}

            {phase === "speaking" ? (
              <div className="model-thinking">
                <AudioLines size={20} />
                <b>我先把题目读给你听</b>
                <span>没听清也没关系，之后可以点“重听题目”</span>
              </div>
            ) : null}

            {phase === "ending" ? (
              <div className="model-thinking">
                <Sparkles className="spin" size={20} />
                <b>正在为你写复盘</b>
                <span>会先说优点，再给可以练习的方向</span>
              </div>
            ) : null}

            {phase === "awaiting" || phase === "listening" || phase === "texting" ? (
              <button className="small-btn danger" onClick={endEarly} disabled={earlyEnding}>
                <CircleStop size={15} />
                提前结束
              </button>
            ) : null}
          </div>
        </div>
      </section>

      <section className="qa-strip">
        <span>已完成 {completedRounds} 轮</span>
        {history.length ? (
          <div className="qa-mini-list">
            {history.slice(-3).map((round, index) => (
              <span
                key={`${String(round.question || "round").slice(0, 12)}-${index}`}
                title={`${round.question || "未知问题"}\n${round.answer || "跳过"}`}
              >
                {round.answer ? "已答" : "跳过"} · {round.focus || "综合考察"}
              </span>
            ))}
          </div>
        ) : (
          <span>还没有完成的问题</span>
        )}
      </section>
    </div>
  );
}
