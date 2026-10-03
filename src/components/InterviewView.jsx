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
import useCamera from "../hooks/useCamera.js";
import useTts from "../hooks/useTts.js";
import useAnswerBuffer from "../hooks/useAnswerBuffer.js";
import useSpeechRecognition, { getSpeechRecognitionCtor } from "../hooks/useSpeechRecognition.js";

export default function InterviewView({ settings, onFinish, onExit }) {
  const [phase, setPhase] = useState("starting");
  const [statusText, setStatusText] = useState("准备本场面试");
  const [history, setHistory] = useState([]);
  const [currentQuestion, setCurrentQuestion] = useState(null);
  const [liveAnswer, setLiveAnswer] = useState("");
  const [textAnswer, setTextAnswer] = useState("");
  const [speechAvailable] = useState(Boolean(window.SpeechRecognition || window.webkitSpeechRecognition));
  const [speechError, setSpeechError] = useState("");
  const [micCheck, setMicCheck] = useState("idle");
  const [micCheckMsg, setMicCheckMsg] = useState("");
  const [bufferActive, setBufferActive] = useState(false);
  const [bufferSeconds, setBufferSeconds] = useState(0);
  const [pauseCount, setPauseCount] = useState(0);
  const [hintsUsed, setHintsUsed] = useState(0);
  const [sourceNote, setSourceNote] = useState("");
  const [earlyEnding, setEarlyEnding] = useState(false);
  const [textFallback, setTextFallback] = useState(false);

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

  function startListening() {
    if (finishedRef.current) return;
    if (!getSpeechRecognitionCtor()) {
      setSpeechError("当前浏览器不支持语音识别，请直接使用文字回答。");
      skipToText();
      return;
    }
    startRecognition();
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
    setBufferState(false);

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
            {speechAvailable ? null : (
              <div className="inline-warning">
                当前浏览器不支持语音识别（Web Speech API），语音面试会自动降级为文字。
                建议使用最新版 Chrome / Edge；也可以直接在这里改用文字面试。
              </div>
            )}
          </div>
          <div className="ready-actions">
            <button className="primary-btn wide ready-start-btn" onClick={startSession}>
              <Mic size={18} />
              {speechAvailable ? "点击开始语音面试" : "仍然开始（将自动转为文字）"}
            </button>
            {speechAvailable ? null : (
              <button className="outline-btn" onClick={startTextInterview}>
                <MessageSquareText size={16} />
                改用文字面试
              </button>
            )}
          </div>
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
