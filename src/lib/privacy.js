// 数据流向的统一说法。公开部署（例如魔搭创空间）时必须如实写明
// "哪些内容会离开浏览器、存在谁那里"，不能只说"只保存在本机"。
//
// 有了账号体系之后，"只存本机"这句话更不成立了：简历是跟着账号存在服务端的，
// 所以这里补上 account 这一段，并把顺序固定为 本机 → 账号（服务端）→ 模型 → 录音。
export const DATA_FLOW = {
  local: "面试记录与设置只存在你自己的浏览器里（localStorage，最多 7 场，可一键清除）。",
  account: "账号与你自己保存的简历存放在部署方服务器上，按账号隔离：其他访客看不到，密码只保留不可逆的哈希，随时可以在「面试记录」页导出或注销删除。",
  model: "开启模型或使用本站共享额度时，简历、岗位描述与你的回答会发送给模型服务，用于出题、追问与整场评分。"
};

// 录音去哪，跟"本站用的是哪种识别"绑定，不能拿一句固定文案糊过去：
// 创空间上没配 ASR_* 时走的是浏览器自带识别，录音交给浏览器厂商（Chrome 用 Google），
// 根本不会到部署方服务器——照抄"会上传到部署方服务器"就是错的说法。
const VOICE_FLOW = {
  server: "语音作答的录音会上传到部署方服务器做文字识别（只做转写，不长期保存音频）。",
  browser: "语音作答的录音会交给浏览器自带的语音识别服务（例如 Chrome 用 Google）转成文字，不会上传到部署方服务器。",
  text: "本站当前以文字作答为主，不会有录音离开浏览器。",
  unknown: "语音作答的录音去往哪里取决于本站启用的识别方式：服务端识别会上传到部署方服务器，浏览器自带识别则交给浏览器厂商。"
};

export const dataFlowShort = `${DATA_FLOW.local}${DATA_FLOW.account}${DATA_FLOW.model}`;

// engine 取 "server" / "browser" / "text"；能力还没探到时传 undefined，退回中性说法。
export function dataFlowVoice(engine) {
  return VOICE_FLOW[engine] || VOICE_FLOW.unknown;
}

export function dataFlowFull(engine) {
  return dataFlowShort + dataFlowVoice(engine);
}

// 保留期限：写清"多久需要重新登录""数据留到什么时候"，避免访客以为账号是永久的。
export const dataRetention =
  "登录状态默认保留 30 天（部署方可用 SESSION_TTL_DAYS 调整），到期需重新登录；账号与简历一直保留到你主动删除或注销账号。";

// 侧栏这类窄容器只放一句话的缩略版。
export const dataFlowCompact = "记录存本机；简历存账号（服务端）；开启模型后简历与回答会发给模型服务";
