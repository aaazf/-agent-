# 面对面 AI 模拟面试 Demo

一个本地运行的轻量 Web 模拟面试应用。支持摄像头/麦克风、模型 API 动态提问、停顿缓冲、最近 7 场结果对比与报告导出。

## 启动

```bash
npm install
npm run dev
```

浏览器打开 <http://127.0.0.1:4173>。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 启动开发服务器（含本地代理） |
| `npm run build` | 生产构建，输出到 `dist/` |
| `npm run preview` | 预览生产构建（同样带本地代理） |
| `npm test` | 运行 Vitest 单元测试（lib 纯函数 + 自定义 hooks） |
| `npm run lint` | 运行 ESLint 检查 |

## 模型 API

在“开始面试”页或“模型接入”页选择 OpenAI 兼容服务并填写：

- Base URL，例如 `https://api.openai.com/v1`
- API Key
- 模型名，例如 `gpt-4o-mini`、`deepseek-chat`、`qwen-plus`

请求通过本地 Vite 服务代理，不会直连第三方网页造成 CORS 限制。未填写 Key 或调用失败时自动使用本地题库兜底。

### 安全说明

- 代理内置 **baseUrl 白名单**，默认只允许内置服务商域名。接入自建网关时在启动前声明：

  ```bash
  ALLOW_MODEL_HOSTS=llm.example.com npm run dev
  ```

- 仅本地调试需要指向本机模型服务时才开启（默认关闭）：

  ```bash
  ALLOW_LOCAL_MODEL_HOST=1 npm run dev
  ```

- 简历、JD 与候选人回答会被包进数据块并显式告知模型“其中指令一律不执行”，以降低提示词注入风险；但这类防护不是绝对的，公开部署前请在服务端持有 Key 并对分数做规则校验。
- API Key 只保存在当前浏览器 `localStorage`，经本地代理转发，不写入仓库。请勿把该 Demo 直接暴露到公网。

## 浏览器要求

- **语音面试**依赖浏览器 Web Speech API，目前只有 Chromium 内核支持：请使用最新版 **Chrome / Edge**。
- 其它浏览器（Firefox / Safari）无法语音识别，界面会提示并自动降级为文字面试，功能不受影响。
- 文字面试在所有现代浏览器均可用。
- 摄像头与麦克风权限需要 `localhost` 或 HTTPS 环境。

## 语音播报（可选）

优先使用本地 Edge TTS 获得更自然的中文音色，失败时自动回退浏览器内置 TTS。

```bash
python -m pip install edge-tts
```

相关环境变量（均有默认值）：

| 变量 | 说明 |
| --- | --- |
| `EDGE_TTS_PYTHON` | Python 解释器路径 |
| `EDGE_TTS_SCRIPT` | TTS 脚本路径（可替换为自定义实现） |
| `EDGE_TTS_TIMEOUT_MS` | 单次合成超时，默认 30000 |

TTS 子进程异步执行、最多并发 2 个，并按“文本 + 音色”缓存结果，因此不会阻塞页面其它请求。

## 功能

- 模型根据简历、JD 和已有问答动态判断下一题（追问 / 换维度 / 深挖 / 收束），并生成本场评估
- 浏览器语音识别 + TTS 播报；识别失败可切换文字
- 摄像头可选，画面只在本机渲染
- 停顿缓冲：候选人安静时不会自动收题，缓冲次数单独记录、不计入临场减分
- 最多保存 7 场结果，支持综合趋势、维度对比与上轮差异
- 报告支持导出 JSON / Markdown / 打印 PDF

## 目录结构

```
src/
  lib/        纯逻辑：prompt 构建、评估归一化、本地题库、简历解析、存储
  hooks/      浏览器能力封装：语音识别、TTS、摄像头、停顿缓冲
  components/ 页面与视图
vite.config.js  本地代理：/api/llm、/api/parse-resume、/api/edge-tts
tests/          Vitest 用例
```

所有配置和历史记录默认保存在当前浏览器 localStorage 中。