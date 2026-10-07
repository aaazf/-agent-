import { useCallback, useEffect, useRef, useState } from "react";
import {
  AudioLines,
  Bot,
  Camera,
  CameraOff,
  Check,
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
  ShieldCheck,
  Sparkles,
  Video,
  X,
  Zap
} from "lucide-react";
import { callModel, canUseModel, generateInterviewerDecision, buildEvaluateMessages, extractJson } from "../lib/model.js";
import { localQuestion } from "../lib/questions.js";
import { localEvaluation, normalizeModelEvaluation } from "../lib/evaluate.js";
import { addResult, clearSession, loadConsent, loadSession, saveConsent, saveSession, uid } from "../lib/storage.js";
import { buildSnapshot, resumeDecision } from "../lib/session.js";
import useCamera from "../hooks/useCamera.js";
import useTts from "../hooks/useTts.js";
import useAnswerBuffer from "../hooks/useAnswerBuffer.js";
import useSpeechRecognition, { getSpeechRecognitionCtor } from "../hooks/useSpeechRecognition.js";
import useVoiceRecorder, { isVoiceRecordingSupported } from "../hooks/useVoiceRecorder.js";
import { transcribeAudio } from "../lib/asr.js";
import { asrCapability } from "../lib/runtime.js";
import useHostedQuota, { displayModelName, modelAvailable } from "../hooks/useHostedQuota.js";

export default function InterviewView({ settings, onFinish, onExit }) {
  const [phase, setPhase] = useState("starting");
  const [statusText, setStatusText] = useState("准备本场面试");
  const [history, setHistory] = useState([]);
  const [currentQuestion, setCurrentQuestion] = useState(null);
  const [liveAnswer, setLiveAnswer] = useState("");
  const [textAnswer, setTextAnswer] = useState("");
  const [speechAvailable] = useState(Boolean(getSpeechRecognitionCtor()));
  const [voiceEngine, setVoiceEngine] = useState(null);
  const [speechError, setSpeechError] = useState("");
  const [micCheck, setMicCheck] = useState("idle");
  const [micCheckMsg, setMicCheckMsg] = useState("");
  // 语音作答会在本机之外处理音频，先明确告知再开始；确认状态只存本机。
  const [consent, setConsent] = useState(() => loadConsent());
  // 站点共享额度：决定出题/评分走不走模型，也决定界面上显示的引擎名。
  const hosted = useHostedQuota();
  const hostedRef = useRef(null);
  hostedRef.current = hosted;
  const [bufferActive, setBufferActive] = useState(false);
  const [bufferSeconds, setBufferSeconds] = useState(0);
  const [pauseCount, setPauseCount] = useState(0);
  const [hintsUsed, setHintsUsed] = useState(0);
  const [sourceNote, setSourceNote] = useState("");
  const [earlyEnding, setEarlyEnding] = useState(false);
  const [textFallback, setTextFallback] = useState(false);
  // 上一场没面完的邀请：只在"同一场面试"且还有题没答时出现。
  const [resumeOffer, setResumeOffer] = useState(null);

  const submittingRef = useRef(false);
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
  const bufferActiveRef = useRef(false);
  const settingsRef = useRef(settings);
  const submitAnswerRef = useRef(null);
  const voiceEngineRef = useRef(null);
  const voiceActiveRef = useRef(false);
  settingsRef.current = settings;

  const updateHistory = (next) => {
    historyRef.current = next;
    setHistory(next);
  };

  const setLive = (value) => {
    liveRef.current = value;
    setLiveAnswer(value);
  };

  // 同时更新 ref 与 UI 状态，保证定时器读到的是最新值，且定时器本身不必重建。
  const setBufferState = useCallback((active, seconds = 0) => {
    bufferActiveRef.current = active;
    setBufferActive(active);
    setBufferSeconds(seconds);
  }, []);
  // submitAnswer 为函数声明，会提升到组件作用域顶部，这里始终指向最新实现。
  submitAnswerRef.current = submitAnswer;

  const isTextMode = settings.interviewMode === "text" || textFallback;
  // speak 是 useCallback 缓存的长生命周期函数，用 ref 读取最新的文字模式状态，避免闭包过期。
  const isTextModeRef = useRef(isTextMode);
  isTextModeRef.current = isTextMode;

  async function startSession() {
    if (settings.cameraOn && !cameraOn && !cameraStarting) startCamera();
    const forceText = await ensureMicrophone();
    await askQuestion({ nextHistory: [], mode: "first", forceText });
  }

  // 语音面试前的麦克风自检：拿不到权限就转文字，别让用户卡在注定失败的流程里。
  async function ensureMicrophone() {
    if (!(settings.interviewMode === "voice" && navigator.mediaDevices?.getUserMedia)) return false;
    try {
      const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      mic.getTracks().forEach((track) => track.stop());
      return false;
    } catch {
      setTextFallback(true);
      setSpeechError("无法获得麦克风权限，本场已自动切换为文字面试。");
      return true;
    }
  }

  // 接着上一场面完：把已答轮次放回历史，再按同一套流程问下一题。
  async function continueSession() {
    const offer = resumeOffer;
    if (!offer) return;
    if (settings.cameraOn && !cameraOn && !cameraStarting) startCamera();
    updateHistory(offer.snapshot.history);
    setResumeOffer(null);
    sessionStartRef.current = offer.snapshot.startedAt || Date.now();
    const forceText = await ensureMicrophone();
    await askQuestion({ nextHistory: offer.snapshot.history, forceText });
  }

  // 明确重开：顺手清掉快照，免得下次进来又被问"要不要接着面"。
  async function startOver() {
    clearSession();
    setResumeOffer(null);
    sessionStartRef.current = Date.now();
    if (settings.interviewMode === "text") {
      await startTextInterview();
      return;
    }
    phaseRef.current = "ready";
    setPhase("ready");
    setStatusText("准备好后点击开始，进入自动听答的语音面试");
  }

  // 浏览器不支持语音识别时，直接以文字模式开场，避免走一遍注定失败的语音流程。
  async function startTextInterview() {
    skipToText();
    await askQuestion({ nextHistory: [], mode: "first", forceText: true });
  }

  const { speak, cancelSpeech } = useTts({
    autoSpeak: settings.autoSpeak,
    voiceName: settings.voiceName,
    isTextModeRef
  });

  const {
    cameraOn,
    cameraStarting,
    cameraError,
    videoRef,
    startCamera,
    stopCameraStream,
    toggleCamera
  } = useCamera();

  const handleRecognitionResult = useCallback(
    ({ finals, interim }) => {
      finals.forEach((transcript) => {
        setLive((prev) => {
          const next = `${prev}${transcript}`;
          liveRef.current = next;
          return next;
        });
      });
      if (interim) setLiveAnswer(`${liveRef.current}${interim}`.trim());
      lastSpeechAtRef.current = Date.now();
      startedSpeechRef.current = true;
      setBufferState(false);
    },
    [setBufferState]
  );

  const handleRecognitionStart = useCallback(() => {
    startedSpeechRef.current = false;
    lastSpeechAtRef.current = Date.now();
  }, []);

  const {
    listening,
    startListening: startRecognition,
    stopRecognition
  } = useSpeechRecognition({
    finishedRef,
    phaseRef,
    setPhase,
    setStatusText,
    setSpeechError,
    setTextFallback,
    cancelSpeech,
    onResult: handleRecognitionResult,
    onRecognitionStart: handleRecognitionStart
  });

  useAnswerBuffer({
    active: phase === "listening",
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
  });

  // 录音期间的“是否在说话”判定交给现有的 useAnswerBuffer 计时，避免改动语音面试状态机。
  const handleVoiceLevel = useCallback((_rms, speaking) => {
    if (!speaking) return;
    lastSpeechAtRef.current = Date.now();
    startedSpeechRef.current = true;
    if (!voiceActiveRef.current) {
      voiceActiveRef.current = true;
      setStatusText("我在听，你按自己的节奏说，中间停顿没关系");
    }
  }, []);

  const {
    recording,
    recordingRef,
    start: startRecording,
    stop: stopRecording,
    releaseStream
  } = useVoiceRecorder({ onLevel: handleVoiceLevel });

  // 语音“正在采集”的统一状态：浏览器识别（listening）与服务端录音（recording）共用同一套按钮语义。
  // 必须放在这两个来源都声明之后，否则会在 TDZ 里读 const。
  const capturing = listening || recording;

  // 优先服务端识别：不依赖浏览器自带语音服务，创空间里也少了“必须 Chromium”的限制。
  const resolveVoiceEngine = useCallback(async () => {
    if (voiceEngineRef.current) return voiceEngineRef.current;
    let engine = "text";
    if (isVoiceRecordingSupported()) {
      const asr = await asrCapability();
      engine = asr.available ? "server" : getSpeechRecognitionCtor() ? "browser" : "text";
    } else if (getSpeechRecognitionCtor()) {
      engine = "browser";
    }
    voiceEngineRef.current = engine;
    setVoiceEngine(engine);
    return engine;
  }, []);

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
    } catch {
      setMicCheck("error");
      setMicCheckMsg("麦克风不可用或权限被拒绝，可先点“允许麦克风”再重试");
    }
  }

  async function askQuestion({ nextHistory, mode = "next", forceText = false, forceLocal = false }) {
    if (finishedRef.current) return;
    phaseRef.current = "thinking";
    setPhase("thinking");
    setStatusText(mode === "first" ? "我先看看你的简历和岗位，给你准备一个合适的开头" : "我听到你刚才的回答了，先想一下接下来怎么问更合适");
    setBufferState(false);
    startedSpeechRef.current = false;

    let question;
    // 是否走模型由 canUseModel 统一决定（自带 Key 或本站共享额度），
    // 不能再看 settings.apiKey：那会让用共享额度的访客整场落到本地题库。
    if (!forceLocal && (await canUseModel(settings))) {
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

  async function startListening() {
    if (finishedRef.current) return;
    voiceActiveRef.current = false;
    const engine = await resolveVoiceEngine();
    if (finishedRef.current) return;
    if (engine === "server") {
      setSpeechError("");
      const result = await startRecording();
      if (result.ok) return;
      setSpeechError(`${result.error}，这一场已切换为文字回答。`);
      skipToText();
      return;
    }
    if (engine === "browser") {
      startRecognition();
      return;
    }
    setSpeechError("当前环境无法进行语音识别，请直接使用文字回答。");
    skipToText();
  }

  function skipToText() {
    stopRecognition();
    stopRecording();
    releaseStream();
    setTextFallback(true);
    phaseRef.current = "texting";
    setPhase("texting");
    setStatusText("文字回答模式，输入后发送即可");
  }

  // 停止录音并把音频交给服务端识别；识别结果写回 liveRef 后，后续流程与浏览器识别完全一致。
  async function finalizeVoiceAnswer() {
    if (!recordingRef.current) return "";
    setStatusText("正在把你刚才的回答转成文字…");
    const blob = await stopRecording();
    if (!blob) return "";
    const text = await transcribeAudio(blob);
    setLive(liveRef.current ? `${liveRef.current}${text}` : text);
    return text;
  }

  async function submitAnswer({ skip = false } = {}) {
    if (submittingRef.current) return;
    submittingRef.current = true;
    if (recordingRef.current && !skip) {
      try {
        await finalizeVoiceAnswer();
      } catch (err) {
        submittingRef.current = false;
        setSpeechError(err.message || "语音识别失败");
        setStatusText("这一题先改用文字回答吧");
        skipToText();
        return;
      }
    }
    const answer = (liveRef.current || textAnswer).trim();
    if (!answer && !skip) {
      setStatusText("如果还没想好也没关系，可以先要个提示，或输入一点想法再继续。");
      submittingRef.current = false;
      return;
    }
    stopRecognition();
    stopRecording();
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
    setTextAnswer("");
    setBufferState(false);

    if (nextHistory.length >= settings.questionCount) {
      await finishInterview(nextHistory);
      return;
    }
    // 每答完一题就落一次盘：刷新、误关页面或手机切后台后还能接着面完。
    saveSession(buildSnapshot({ settings, history: nextHistory, startedAt: sessionStartRef.current }));
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
    // 整场已经收尾，快照的使命结束，留着只会让人反复看到"继续上一场"。
    clearSession();
    stopRecognition();
    stopRecording();
    releaseStream();
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
    if (await canUseModel(settings)) {
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
        modelName: displayModelName({ settings, hosted: hostedRef.current })
      },
      history: nextHistory,
      evaluation,
      stats: {
        durationMs: Date.now() - sessionStartRef.current,
        pauseCount: totalPauses,
        hintsUsed,
        modelUsed: nextHistory.some((r) => r.source === "model"),
        voiceEngine: voiceEngineRef.current || "text",
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
    // 上一场没面完就先问一句：接着面完，还是重新开始。此时不碰摄像头与语音引擎，
    // 用户还没决定要不要继续这一场，没必要先占设备。
    const pending = resumeDecision(loadSession(), settings);
    if (pending.ok) {
      setResumeOffer(pending);
      phaseRef.current = "resuming";
      setPhase("resuming");
      setStatusText(`上一场面到第 ${pending.answered} / ${pending.total} 题，可以接着面完`);
    } else {
      if (settings.cameraOn) startCamera();
      if (settings.interviewMode !== "text") {
        resolveVoiceEngine();
        phaseRef.current = "ready";
        setPhase("ready");
        setStatusText("准备好后点击开始，进入自动听答的语音面试");
      } else {
        askQuestion({ nextHistory: [], mode: "first" });
      }
    }
    return () => {
      finishedRef.current = true;
      stopRecognition();
      stopRecording();
      releaseStream();
      cancelSpeech();
      stopCameraStream();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const completedRounds = history.length;
  const currentNumber = Math.min(completedRounds + 1, settings.questionCount);
  // 语音面试没有对话记录面板，候选人看不到“被听成了什么”；回显上一题识别结果补上这个信任缺口。
  const lastRecognizedAnswer = completedRounds ? history[completedRounds - 1].answer : "";
  const voiceUsable = speechAvailable || voiceEngine === "server";
  const modelReady = modelAvailable({ settings, hosted });
  const modelLabel = displayModelName({ settings, hosted }) || "模型";
  // 只在真的会走语音时才拦人；改用文字面试的路径不需要任何确认。
  const needsVoiceConsent = !isTextMode && voiceUsable && !consent.voiceUpload;

  const acknowledgeVoiceConsent = () => {
    setConsent(saveConsent({ voiceUpload: true }));
  };

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
          <span className="source-badge">{sourceNote || (modelReady ? "模型驱动提问" : "本地题库")}</span>
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
            {speechAvailable || voiceEngine === "server" ? null : (
              <div className="inline-warning">
                当前浏览器不支持语音识别（Web Speech API），语音面试会自动降级为文字。
                建议使用最新版 Chrome / Edge；也可以直接在这里改用文字面试。
              </div>
            )}
            {voiceEngine === "server" ? (
              <div className="hint-block">
                <Mic size={14} />
                语音识别在服务端完成，不依赖浏览器自带语音服务；说完停顿几秒会自动提交。
              </div>
            ) : null}
            {!isTextMode && voiceUsable ? (
              <div className="voice-consent">
                <div className="voice-consent-title">
                  <ShieldCheck size={14} />
                  开始前请先了解这段录音会被怎么处理
                </div>
                <ul>
                  <li>
                    {voiceEngine === "server"
                      ? "你答完一道题，这段录音会以音频形式上传到本站服务器，再由部署方配置的语音识别服务转成文字，用于继续提问。"
                      : "你答完一道题，浏览器会把这段语音交给它内置的语音识别服务（例如 Chrome 使用 Google）转成文字，用于继续提问。"}
                  </li>
                  <li>录音只在识别时转发，服务端不保存音频文件；面试记录只存在你自己的浏览器里，最多 7 场，可一键清除。</li>
                  <li>请勿在回答中说出身份证号、银行卡号等敏感信息。</li>
                </ul>
                <button
                  type="button"
                  className={consent.voiceUpload ? "small-btn" : "small-btn danger"}
                  onClick={acknowledgeVoiceConsent}
                  disabled={consent.voiceUpload}
                >
                  {consent.voiceUpload ? <Check size={14} /> : <ShieldCheck size={14} />}
                  {consent.voiceUpload ? "已确认，可以开始" : "我已知晓，同意上传录音识别"}
                </button>
              </div>
            ) : null}
          </div>
          <div className="ready-actions">
            <button
              className="primary-btn wide ready-start-btn"
              onClick={startSession}
              disabled={needsVoiceConsent}
            >
              <Mic size={18} />
              {needsVoiceConsent
                ? "请先确认上方语音告知"
                : voiceUsable
                  ? "点击开始语音面试"
                  : "仍然开始（将自动转为文字）"}
            </button>
            <button className="outline-btn" onClick={startTextInterview}>
              <MessageSquareText size={16} />
              {voiceUsable ? "不想上传录音，改用文字面试" : "改用文字面试"}
            </button>
          </div>
        </section>
      ) : null}

      {resumeOffer ? (
        <section className="panel resume-panel">
          <div className="resume-panel-title">
            <Clock3 size={17} />
            <div>
              <b>上一场还没面完</b>
              <small>
                {settings.role} · {settings.direction} · 已完成 {resumeOffer.answered} / {resumeOffer.total} 题
              </small>
            </div>
          </div>
          <p>
            接着面完会保留已经答过的 {resumeOffer.answered} 道题，从第 {resumeOffer.answered + 1} 题继续，整场结束后一起评分。
          </p>
          <div className="ready-actions">
            <button className="primary-btn" onClick={continueSession}>
              <Play size={17} />
              接着面完（第 {resumeOffer.answered + 1} 题）
            </button>
            <button className="outline-btn" onClick={startOver}>
              <RotateCcw size={16} />
              放弃上一场，重新开始
            </button>
          </div>
        </section>
      ) : null}

      <div
        className={isTextMode ? "stage-grid text-layout" : "stage-grid"}
        style={resumeOffer ? { display: "none" } : undefined}
      >
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
              <small>{sourceNote || (modelReady ? `提问引擎：${modelLabel}` : "本地兜底出题")}</small>
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
          {recording ? (
            <div className="hint-block">
              <AudioLines size={14} />
              正在录音（服务端识别）：说完停顿几秒会自动提交，也可以点“我说完了”。
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
            {lastRecognizedAnswer ? (
              <div className="voice-transcript">
                <div className="stage-title">
                  <FileText size={15} />
                  上一题识别结果
                </div>
                <p>{lastRecognizedAnswer}</p>
              </div>
            ) : null}
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
              <b>{bufferActive ? `不催你 · 我还在听（已停 ${bufferSeconds} 秒）` : capturing ? "聆听中 · 停顿会被理解" : "准备好了随时开始"}</b>
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
                {isTextMode ? <MessageSquareText size={14} /> : capturing ? <MicOff size={14} /> : <Mic size={14} />}
                你的回答
              </span>
              <small>
                {isTextMode
                  ? "文字输入"
                  : capturing
                    ? voiceEngine === "server"
                      ? "正在录音…"
                      : "正在识别…"
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
            {!isTextMode && !speechAvailable && voiceEngine !== "server" ? (
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
                  onClick={capturing ? () => submitAnswer() : startListening}
                  disabled={phase === "ending"}
                >
                  {capturing ? <Check size={19} /> : <Mic size={19} />}
                  {capturing ? "我说完了" : "开始回答"}
                </button>
                {capturing ? (
                  <button className="outline-btn" onClick={skipToText}>
                    <FileText size={15} />
                    改用文字
                  </button>
                ) : null}
                {!capturing && (liveAnswer || textAnswer) ? (
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
