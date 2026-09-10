# 面对面 AI 模拟面试 Demo

一个本地运行的轻量 Web 模拟面试应用。支持摄像头/麦克风、模型 API 动态提问、停顿缓冲、最近 7 场结果对比与报告导出。

## 启动

```bash
cd "C:\Users\xx\Desktop\面试agent"
npm install
npm run dev
```

浏览器打开 <http://127.0.0.1:4173>。

## 模型 API

在“开始面试”页面选择 OpenAI 兼容服务并填写：

- Base URL，例如 `https://api.openai.com/v1`
- API Key
- 模型名，例如 `gpt-4o-mini`、`deepseek-chat`、`qwen-plus`

请求通过本地 Vite 服务代理，不会直连第三方网页造成 CORS 限制。未填写 Key 时自动使用本地题库兜底。

## 功能

- 模型根据简历、JD 和已有问答动态判断下一题，并生成本场评估
- 浏览器语音识别 + TTS 播报；识别失败可切换文字
- 摄像头可选，画面只在本机渲染
- 停顿缓冲：候选人安静时不会自动收题，缓冲次数单独记录、不计入临场减分
- 最多保存 7 场结果，支持综合趋势、维度对比与上轮差异
- 报告支持导出 JSON / Markdown / 打印 PDF

所有配置和历史记录默认保存在当前浏览器 localStorage 中。
