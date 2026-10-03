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

`npm run e2e` 会在本机启动 Chrome 跑 15 条断言，实测结论：

| 场景 | 实测结果 |
| --- | --- |
| 顶层窗口（新窗口打开） | 伪麦克风 `getUserMedia` 成功；`SpeechRecognition` 能真实启动（`onstart` 触发，未被权限拒绝） |
| 创空间式内嵌 + 父页未授权 | 浏览器直接返回 `NotAllowedError`；页面显示内嵌提示条；**文字面试仍能从第 1 题完整推进到第 2 题** |
| 内嵌 + 父页写了 `allow="microphone; camera"` | 麦克风 `granted`，语音识别同样能启动 —— 说明只要宿主页配合，内嵌也可用语音 |

所以社区的兜底路径是可靠的；想拿到完整体验，让访客点"在新窗口打开"即可。

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
| `ALLOWED_FRAME_ANCESTORS` | 否 | 默认 `*`（任意 http/https 站点可内嵌）；收紧示例 `https://modelscope.cn` |
| `EDGE_TTS_PYTHON` | 否 | 容器内已设为 `python3`，通常不用改 |

配了 `HOSTED_LLM_TOKEN` 之后，访客在"模型接入"页会看到"本站已开启共享体验额度"，**API Key 留空即可直接开始面试**；额度用尽时接口返回 `429`（`code=hosted_quota_exceeded`），前端提示填写自己的 Key 并自动回退本地题库，不会白屏。

## 5. 部署后自检

```bash
curl -s -X POST https://<你的创空间域名>/api/health
```

期望返回：

```json
{"ok":true,"tts":{"available":true,"reason":""},"hostedLlm":{"enabled":true,"model":"Qwen/Qwen3-8B","perIpPerDay":40},"limits":{"maxBodyBytes":12582912,"llmPerMinute":20}}
```

- `tts.available=false`：容器内没有可用的 `python3 + edge-tts`，语音播报会自动降级为浏览器内置 TTS，不影响流程。
- `hostedLlm.enabled=false`：没配托管 Key，访客需自带 Key 才能用模型提问（否则走本地题库）。

浏览器端建议再走一遍：登录 → 模型接入 → 简历分析 → 设备预检 → 文字面试 → 复盘报告。有 Chrome 的机器可以直接跑：

```bash
npm run build
npm start                      # 另开终端
NODE_PATH=$(npm root -g) npm run e2e     # Windows: $env:NODE_PATH = (npm root -g); npm run e2e
```

## 6. 访客会遇到的限制（建议写进创空间说明）

- **语音作答**需要 Chromium 内核浏览器（Chrome / Edge）；创空间若以内嵌 iframe 打开，还需要宿主页面的 `allow="microphone; camera"`，否则浏览器直接拒绝。页面底部的提示条会说明这一点，并提供"在新窗口打开"。
- **摄像头**同理，失败不影响语音/文字作答。
- **登录是演示鉴权**：点击即进入，不做真实账号校验，也不存在服务端账号体系。
- **数据不落盘**：简历在服务端内存中解析、不写磁盘；面试历史只存在访客自己的浏览器 `localStorage`（最多 7 场）；服务端不保存面试数据。
- 简历内容与回答会发送给所配置的模型服务（自带 Key 时是访客选的服务商，托管额度时是魔搭 API-Inference），请在创空间说明里注明并提示不要上传敏感信息。

## 7. 成本与安全清单（上线前逐条确认）

- 托管 Key 只放在创空间环境变量，仓库里没有明文；`.env` 已在 `.gitignore` 中。
- `HOSTED_REQUESTS_PER_DAY` 已按预算设置（例如 800 次 × 单次约 1.2k tokens）。
- `/api/llm` 的 `baseUrl` 受白名单限制，无法被当作任意请求跳板；请求体上限 12MB。
- 托管额度上限会同时约束 `max_tokens`，避免访客用大输出刷成本。
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