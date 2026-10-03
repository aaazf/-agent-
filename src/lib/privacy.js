// 数据流向的统一说法。公开部署（例如魔搭创空间）时必须如实写明
// "哪些内容会离开浏览器"，不能只说"只保存在本机"。
// 这几个页面原来各自写一句，其中"数据仅保存在当前浏览器"只讲了一半：
// 开启模型（含本站共享额度）后，简历、岗位描述与回答都会发给模型服务。
export const DATA_FLOW = {
  local: "面试记录与设置只存在你自己的浏览器里（localStorage，最多 7 场，可一键清除）。",
  model: "开启模型或使用本站共享额度时，简历、岗位描述与你的回答会发送给模型服务，用于出题、追问与整场评分。",
  voice: "语音作答的录音会上传到部署方服务器做文字识别，面试前会再确认一次。"
};

export const dataFlowShort = `${DATA_FLOW.local}${DATA_FLOW.model}`;
export const dataFlowFull = `${dataFlowShort}${DATA_FLOW.voice}`;

// 侧栏这类窄容器只放一句话的缩略版。
export const dataFlowCompact = "记录存本机；开启模型后简历与回答会发给模型服务";
