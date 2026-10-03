# 部署到 ModelScope 创空间

本文只讲"怎么把它跑在创空间并给社区用"，不重复前端功能说明。

## 1. 先明确三条硬约束

| 约束 | 原因 | 本仓库的处理 |
| --- | --- | --- |
| 必须监听 `0.0.0.0:7860` | 创空间容器只把 7860 暴露给反向代理 | `Dockerfile` 里设 `HOST=0.0.0.0`、`PORT=7860`，由 `server/index.mjs` 提供 HTTP 服务 |
| 麦克风/摄像头需要安全上下文 + iframe 授权 | `getUserMedia` 要求 HTTPS 或 localhost；跨源 iframe 还需要父页面的 `allow="microphone; camera"` | 语音/摄像头按"渐进增强"处理：失败自动降级文字面试；页面底部常驻提示条 + "在新窗口打开" |
| 站点不能白送模型额度 | 任何公网 Key 都会被刷 | 访客自带 Key 与站点托管 Key（`HOSTED_LLM_TOKEN`）双模式 + 每 IP 每日额度 + 全局每日额度 |

结论：**创空间里"文字面试"是保证可用的主线，"语音/视频面试"在满足浏览器与 iframe 条件时才可用。** 这与本地完整体验的差距来自平台限制，不是代码缺陷。

## 2. 已实测的行为（本地用真实 Chrome 验证）

`npm run e2e` 会在本机启动 Chrome 跑 24 条断言（自带桩 ASR 上游与应用服务器，不需要手工 `npm start`），实测结论：

| 场景 | 实测结果 |
| --- | --- |
| 顶层窗口（新窗口打开） | 伪麦克风 `getUserMedia` 成功；`SpeechRecognition` 能真实启动（`onstart` 触发，未被权限拒绝） |
| 创空间式内嵌 + 父页未授权 | 浏览器直接返回 `NotAllowedError`；页面显示内嵌提示条；**文字面试仍能从第 1 题完整推进到第 2 题** |
| 内嵌 + 父页写了 `allow="microphone; camera"` | 麦克风 `granted`，语音识别同样能启动 —— 说明只要宿主页配合，内嵌也可用语音 |
| 服务端语音识别全链路 | 伪麦克风真实录音（约 48KB）→ `/api/asr` → 上游 multipart → 转写文字 → 面试推进到第 2 题，且页面显示"上一题识别结果" |
| 语音作答前的告知 | 全新访客进入语音就绪页时出现告知卡、开始按钮被拦截；点"我已知晓"后按钮解除拦截并可继续 |

所以社区的兜底路径是可靠的；想拿到完整体验，让访客点"在新窗口打开"即可。

**语音识别建议走服务端**：浏览器内置的 Web Speech 需要能访问 Google，国内常不可用，且只有 Chromium 支持。服务端识别（`ASR_*`）让访客不必自带 Key，也不再受浏览器限制。

## 3. 创建创空间

1. 打开 `https://modelscope.cn/studios` → 新建创空间。
2. 类型选 **Docker**，端口填 **7860**，可见性选"公开"（只有公开才允许被 `iframe` 嵌入）。
3. 把本仓库推到创空间的 Git 仓库：

```bash
git remote add modelscope <创空间 Git 地址>
git push modelscope main
```

4. 创空间会执行仓库根目录的 `Dockerfile`：安装 `python3 + edge-tts` → `npm ci` → `npm run build` → `npm start`。

## 4. 在创空间设置环境变量

在创空间的"环境变量/密钥"面板配置（**不要写进代码或 `.env` 提交**）：

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `HOSTED_LLM_TOKEN` | 建议 | 站点托管额度用的 Key（魔搭 API-Inference 令牌）。为空则访客必须自带 Key |
| `HOSTED_LLM_BASE_URL` | 否 | 默认 `https://api-inference.modelscope.cn/v1` |
| `HOSTED_LLM_MODEL` | 否 | 默认 `Qwen/Qwen3-8B`，托管额度强制使用该模型，避免访客指定贵模型 |
| `HOSTED_REQUESTS_PER_IP_PER_DAY` | 否 | 默认 40，单访客每日托管调用上限 |
| `HOSTED_REQUESTS_PER_DAY` | 否 | 默认 800，全局每日兜底（真正的成本闸门） |
| `LLM_REQUESTS_PER_MINUTE` | 否 | 默认 20，单 IP 每分钟限流 |
| `ASR_BASE_URL` | 建议 | OpenAI 兼容的 ASR 上游，例如 `https://api.siliconflow.cn/v1`；不填则回落到 `HOSTED_LLM_BASE_URL` |
| `ASR_MODEL` | 建议 | ASR 模型名，例如 `FunAudioLLM/SenseVoiceSmall`。与 Base URL、Token 三者齐备才生效 |
| `ASR_TOKEN` | 否 | 不填则复用 `HOSTED_LLM_TOKEN`（同一令牌同时用于 LLM 与 ASR） |
| `ASR_REQUESTS_PER_DAY` | 否 | 默认 600，全局每日语音识别次数上限（成本闸门） |
| `ASR_REQUESTS_PER_MINUTE` | 否 | 默认 20，单 IP 每分钟语音识别限流 |
| `ALLOWED_FRAME_ANCESTORS` | 否 | 默认 `*`（任意 http/https 站点可内嵌）；收紧示例 `https://modelscope.cn` |
| `EDGE_TTS_PYTHON` | 否 | 容器内已设为 `python3`，通常不用改 |

ASR 上游的契约很小：`POST {ASR_BASE_URL}/audio/transcriptions`，`multipart/form-data` 带 `file` / `model` / `language`，返回 `{"text": "..."}`。满足这个契约的服务都能直接接，换供应商只改这三个变量。没配置时 `/api/asr` 返回 `503 asr_unavailable`，前端自动退回浏览器识别或文字作答。

配了 `HOSTED_LLM_TOKEN` 之后，访客在"模型接入"页会看到"本站已开启共享体验额度"，**API Key 留空即可直接开始面试**；额度用尽时接口返回 `429`（`code=hosted_quota_exceeded`），前端提示填写自己的 Key 并自动回退本地题库，不会白屏。

## 5. 部署后自检

```bash
curl -s -X POST https://<你的创空间域名>/api/health
```

期望返回：

```json
{
  "ok": true,
  "tts": { "available": true, "reason": "" },
  "asr": { "available": true, "model": "FunAudioLLM/SenseVoiceSmall", "reason": "" },
  "hostedLlm": { "enabled": true, "model": "Qwen/Qwen3-8B", "perIpPerDay": 40 },
  "limits": { "maxBodyBytes": 12582912, "llmPerMinute": 20, "asrPerMinute": 20, "asrPerDay": 600 }
}
```

- `tts.available=false`：容器内没有可用的 `python3 + edge-tts`，语音播报会自动降级为浏览器内置 TTS，不影响流程。
- `hostedLlm.enabled=false`：没配托管 Key，访客需自带 Key 才能用模型提问（否则走本地题库）。
- `asr.available=false`：`reason` 会说明缺哪个变量；此时语音作答自动退回浏览器识别或文字作答。

浏览器端建议再走一遍：登录 → 模型接入 → 简历分析 → 设备预检 → 文字面试 → 复盘报告。有 Chrome 的机器可以直接跑：

```bash
npm run build
npm start                      # 另开终端
NODE_PATH=$(npm root -g) npm run e2e     # Windows: $env:NODE_PATH = (npm root -g); npm run e2e
```

## 6. 访客会遇到的限制（建议写进创空间说明）

- **语音作答**会自动选引擎：配了 `ASR_*` 时任何支持 `MediaRecorder` 的现代浏览器都能录音作答；只有退回浏览器识别时才需要 Chromium 内核。创空间若以内嵌 iframe 打开，还需要宿主页面的 `allow="microphone; camera"`，否则浏览器直接拒绝；页面底部的提示条会说明并提供"在新窗口打开"。
- **摄像头**同理，失败不影响语音/文字作答。
- **登录是演示鉴权**：点击即进入，不做真实账号校验，也不存在服务端账号体系。
- **数据不落盘**：简历在服务端内存中解析、不写磁盘；面试历史只存在访客自己的浏览器 `localStorage`（最多 7 场），页面提供"清除本机数据"；服务端不保存面试内容，也不保存录音文件。
- **语音录音会外发**：语音作答时音频会发到本站 `/api/asr`，再转发给部署方配置的 ASR 上游转成文字（未配 ASR 时由浏览器自带的语音服务处理）。前端在开始语音面试前会先展示一次告知，访客须确认才能开始，也可以直接改用文字面试。
- 简历内容与回答会发送给所配置的模型服务（自带 Key 时是访客选的服务商，托管额度时是魔搭 API-Inference）。

可以把这个模板粘到创空间的说明里，把方括号换成实际情况：

```text
AI 模拟面试（社区体验版）

这是什么：按真实面试节奏推进的模拟面试。填岗位/简历 → 设备预检 → 语音或文字面试 →
结束后给出维度评分与逐题改进方案，保留最近 7 场做趋势对比。

怎么用：点"登录并进入面试中心"（演示鉴权，不做真实账号校验）→ 模型接入页留空即可用
本站共享额度体验 → 简历可直接用预置示例 → 想做语音面试请用 Chrome/Edge，
并在新窗口打开；若被内嵌且没拿到麦克风权限，会自动降级为文字面试，不影响流程。

数据说明：
· 面试记录与设置只存在你自己浏览器的 localStorage（最多 7 场），可一键清除。
· 语音作答的录音会上传到本站服务器，转发给语音识别服务[填写服务商]转成文字；
  录音不做长期保存。开始语音面试前会再明确告知一次，你随时可以改用文字面试。
· 简历与回答会发送给[填写模型服务商]用于出题和评分。请不要填写身份证号、银行卡号
  等敏感信息；本服务输出仅供练习参考，不构成任何录用承诺。

体验额度：[共享额度每日 N 次，用尽后需要自带 API Key 或等次日重置]
```

## 7. 成本与安全清单（上线前逐条确认）

- 托管 Key 只放在创空间环境变量，仓库里没有明文；`.env` 已在 `.gitignore` 中。
- `HOSTED_REQUESTS_PER_DAY` 已按预算设置（例如 800 次 × 单次约 1.2k tokens）。
- `/api/llm` 的 `baseUrl` 受白名单限制，无法被当作任意请求跳板；请求体上限 12MB。
- 托管额度上限会同时约束 `max_tokens`，避免访客用大输出刷成本。
- `ASR_REQUESTS_PER_DAY` / `ASR_REQUESTS_PER_MINUTE` 已按预算设置（语音识别通常按音频时长计费，建议先按每分钟 1 次、每天 600 次起步观察）。`/api/health` 的 `limits` 可确认生效值。
- 创空间说明里已按上面的模板写明录音会外发与敏感信息提示（公开面向社区时的告知义务）。
- 静态资源带长缓存，`index.html` 每次校验，更新后访客不会停留在旧壳。
- 创空间若会休眠，首个访客可能触发 TTS 探测（约 1 秒内完成），属正常现象。

## 8. 本地先验一遍（推荐）

```bash
npm ci
npm run build
PORT=7860 npm start
# 另开终端
curl -s -X POST http://127.0.0.1:7860/api/health
```

端口占用排查：Windows `netstat -ano | findstr :7860`，macOS/Linux `lsof -i :7860`。
