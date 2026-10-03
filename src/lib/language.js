// 本 Agent 目前只面向中文面试：提示词、面试官播报音色与语音识别都为中文准备。
// 语言值集中在这里，避免 "zh-CN" / "zh" 散落在各处、改一处漏一处；
// 将来要支持英文面试，需要同时替换提示词，不能只改这两个常量。
export const SPEECH_LANG = "zh-CN";
export const ASR_LANG = "zh";
