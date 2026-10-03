// 单一来源：模型服务商与模型目录。
// 被前端（SetupView / ApiAccessView）构建期服务端（vite.config.js 代理白名单）共用。
export const MODEL_CATALOG = {
  OpenAI: {
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "gpt-4.1"]
  },
  DeepSeek: {
    baseUrl: "https://api.deepseek.com",
    models: ["deepseek-chat", "deepseek-reasoner"]
  },
  "阿里云百炼 Qwen": {
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: ["qwen-turbo", "qwen-plus", "qwen-max"]
  },
  "智谱 GLM": {
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    models: ["glm-4-flash", "glm-4-air", "glm-4-plus"]
  },
  Kimi: {
    baseUrl: "https://api.moonshot.cn/v1",
    models: ["moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k"]
  },
  // 魔搭 ModelScope 的 OpenAI 兼容推理接口；模型名是「组织/模型」形式，也可手填其它已上架的模型。
  "魔搭 ModelScope": {
    baseUrl: "https://api-inference.modelscope.cn/v1",
    models: ["Qwen/Qwen3-8B", "Qwen/Qwen2.5-7B-Instruct"]
  },
  自定义: {
    baseUrl: "",
    models: []
  }
};

export const CUSTOM_PROVIDER = {
  label: "自定义",
  baseUrl: "",
  models: [],
  model: ""
};

// 供表单使用：预置服务商（自定义由界面单独追加）
export const PROVIDERS = Object.entries(MODEL_CATALOG)
  .filter(([label]) => label !== "自定义")
  .map(([label, config]) => ({
    label,
    baseUrl: config.baseUrl,
    models: config.models,
    model: config.models[0] || ""
  }));

// 含“自定义”的完整列表
export const PROVIDER_OPTIONS = [...PROVIDERS, CUSTOM_PROVIDER];

export function providerByLabel(label) {
  return PROVIDER_OPTIONS.find((item) => item.label === label) || CUSTOM_PROVIDER;
}
