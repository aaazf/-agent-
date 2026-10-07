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

`npm run e2e` 会在本机启动 Chrome 跑 49 条断言（自带桩 ASR 上游、桩模型上游与两个应用实例，不需要手工 `npm start`），实测结论：

| 场景 | 实测结果 |
| --- | --- |
| 顶层窗口（新窗口打开） | 伪麦克风 `getUserMedia` 成功；`SpeechRecognition` 能真实启动（`onstart` 触发，未被权限拒绝） |
| 创空间式内嵌 + 父页未授权 | 浏览器直接返回 `NotAllowedError`；页面显示内嵌提示条；**文字面试仍能从第 1 题完整推进到第 2 题** |
| 内嵌 + 父页写了 `allow="microphone; camera"` | 麦克风 `granted`，语音识别同样能启动 —— 说明只要宿主页配合，内嵌也可用语音 |
| 服务端语音识别全链路 | 伪麦克风真实录音（约 48KB）→ `/api/asr` → 上游 multipart → 转写文字 → 面试推进到第 2 题，且页面显示"上一题识别结果" |
| 语音作答前的告知 | 全新访客进入语音就绪页时出现告知卡、开始按钮被拦截；点"我已知晓"后按钮解除拦截并可继续 |
| 共享额度不留 Key 走模型 | 另起一个配了 `HOSTED_LLM_TOKEN` 的实例，访客留空 API Key 跑完整场：首题来自模型、逐题追问、整场评分，且上游收到的请求带部署方 Token 与托管模型 |
| 面试被打断可接着面完 | 只答了第 1 题就刷新页面后，重新进入会给出"上一场还没面完（已完成 1 / 6 题）"，点"接着面完"从第 2 题继续，进度显示 1 / 6 |
| 报告带免责与数据流向 | 报告页渲染出评分口径与"简历与回答会发送给模型服务"的说明 |
| 账号与简历跟着账号走 | 注册新账号 → 简历存进服务端 → 刷新页面免密恢复登录态、简历仍在 → 换个新账号看不到别人的简历 → 删除后服务端也不再保留 → 退出登录清掉本机 token |
| 共享额度按账号计数 | 登录访客按账号计数（换 IP、换网络都不重置额度），只有未登录访客才退回按 IP 计数 |

所以社区的兜底路径是可靠的；想拿到完整体验，让访客点"在新窗口打开"即可。

**目前只支持中文面试**：提示词、面试官播报音色与语音识别都按中文准备（`src/lib/language.js` 里集中定义）。换成英文面试不只是改语言代码，提示词也要一起改，因此不在当前范围内。

**语音识别建议走服务端**：浏览器内置的 Web Speech 需要能访问 Google，国内常不可用，且只有 Chromium 支持。服务端识别（`ASR_*`）让访客不必自带 Key，也不再受浏览器限制。

## 3. 创建创空间

1. 打开 `https://modelscope.cn/studios` → 新建创空间（或在已有空间上「复刻」，两者是同一个表单）。
2. 在「接入 SDK」里选 **Docker**，**不要选 Gradio / Streamlit**：本项目的入口是仓库根目录的 `Dockerfile`，选成 Gradio 时平台会去找 `app.py`，部署必然起不来。端口固定 **7860**（docker 型不允许改成别的），可见性选"公开"（只有公开才允许被 `iframe` 嵌入）。
   - **Docker 选项是灰的？** 平台的判断是"国际站，或账号已绑定阿里云并通过实名认证"（前端判定 `isAuthAliyunVerified`）。去 `https://www.modelscope.cn/auth/platform/open` 完成绑定 + 实名认证后即可选中。
   - **SDK 类型创建后不能改**：「编辑创空间」和「创空间设置」页都只读展示 SDK，没有选择入口，所以别在编辑页里找。已经用 Gradio 建好了也不用重来：详情页的「部署设置」会按仓库内容自动判断类型——根目录有 `Dockerfile` 就按 docker 部署，选好实例与端口点部署即可。
3. 平台侧的部署约束（可自查 `curl -s https://www.modelscope.cn/api/v1/studios/deploy_schema.json`）：`sdk_type` 只有 `gradio / streamlit / static / docker` 四种；**docker = 用仓库根目录的 `Dockerfile` 构建镜像，服务必须监听 `0.0.0.0:7860`**，此时不用也不能设 `sdk_version` / `base_image`，`port` 必须恰好是 `7860`。本项目正是按这条写的（`Dockerfile` 里 `HOST=0.0.0.0`、`PORT=7860`）。环境变量也在这个「部署设置」面板里填，一次配好。
4. 把本仓库推到创空间的 Git 仓库（分支用 `master`，创空间默认分支就是它）：

```bash
git remote add modelscope <创空间 Git 地址>
git push modelscope main:master
```

5. 部署后创空间会执行仓库根目录的 `Dockerfile`：安装 `python3 + edge-tts` → `npm ci` → `npm run build` → `npm start`。自查：`curl -s https://www.modelscope.cn/api/v1/studio/<用户名>/<空间名>`，看 `SdkType` / `Status` / `FailedMessage` 三个字段——`Status` 不应长期停在 `Empty`，`FailedMessage` 应为空。

## 4. 配置环境变量

在创空间的「部署设置」里填 `environment_variables`（就是第 3 步那个面板；**不要写进代码或 `.env` 提交**）：

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `HOSTED_LLM_TOKEN` | 建议 | 站点托管额度用的 Key（魔搭 API-Inference 令牌）。为空则访客必须自带 Key |
| `HOSTED_LLM_BASE_URL` | 否 | 默认 `https://api-inference.modelscope.cn/v1` |
| `HOSTED_LLM_MODEL` | 否 | 默认取自 `src/lib/providers.js` 的 `魔搭 ModelScope.models[0]`（当前 `Qwen/Qwen3.5-35B-A3B`）。托管额度强制使用该模型，避免访客指定贵模型。**魔搭模型会上下架，部署后务必用 `npm run preflight` 核对一次** |
| `HOSTED_REQUESTS_PER_IP_PER_DAY` | 否 | 默认 40，**按访客（IP）分别计数**的每日托管调用上限。一整场 6 题面试约 7 次调用，够一位访客练 5 场左右 |
| `HOSTED_REQUESTS_PER_DAY` | 否 | 默认 800，全局每日兜底（真正的成本闸门）。注意 `X-Forwarded-For` 可伪造，所以成本最终由它兜住 |
| `LLM_REQUESTS_PER_MINUTE` | 否 | 默认 20，单 IP 每分钟限流 |
| `ALLOW_SIGNUP` | 否 | 默认开启自助注册；设为 `0` 或 `false` 关闭（已有账号仍能登录） |
| `SIGNUP_INVITE_CODE` | 否 | 填了则注册必须带这个邀请码；公开体验站建议设置，能挡掉绝大多数脚本注册 |
| `SESSION_TTL_DAYS` | 否 | 默认 30，登录态有效期（会话存在服务端，重启进程不会让访客集体掉线） |
| `AUTH_REQUESTS_PER_MINUTE` | 否 | 默认 10，单 IP 每分钟登录/注册请求上限 |
| `SIGNUPS_PER_DAY` | 否 | 默认 200，全站每日注册名额（批量注册的成本闸门） |
| `LOGIN_FAILURES_PER_15MIN` | 否 | 默认 8，同一账号 15 分钟内口令失败次数上限（挡口令爆破） |
| `DATA_DIR` | 建议 | 账号与简历的落盘目录，默认 `<仓库>/data`。**创空间必须指向持久化目录，否则容器一重建账号就没了** |
| `STORE_FILE` | 否 | 直接指定数据文件路径，优先级高于 `DATA_DIR` |
| `ASR_BASE_URL` | 建议 | OpenAI 兼容的 ASR 上游，例如 `https://api.siliconflow.cn/v1`；不填则回落到 `HOSTED_LLM_BASE_URL` |
| `ASR_MODEL` | 建议 | ASR 模型名，例如 `FunAudioLLM/SenseVoiceSmall`。与 Base URL、Token 三者齐备才生效 |
| `ASR_TOKEN` | 否 | 不填则复用 `HOSTED_LLM_TOKEN`（同一令牌同时用于 LLM 与 ASR） |
| `ASR_REQUESTS_PER_DAY` | 否 | 默认 600，全局每日语音识别次数上限（成本闸门） |
| `ASR_REQUESTS_PER_MINUTE` | 否 | 默认 20，单 IP 每分钟语音识别限流 |
| `ALLOWED_FRAME_ANCESTORS` | 否 | 默认 `*`（任意 http/https 站点可内嵌）；收紧示例 `https://modelscope.cn` |
| `EDGE_TTS_PYTHON` | 否 | 容器内已设为 `python3`，通常不用改 |

ASR 上游的契约很小：`POST {ASR_BASE_URL}/audio/transcriptions`，`multipart/form-data` 带 `file` / `model` / `language`，返回 `{"text": "..."}`。满足这个契约的服务都能直接接，换供应商只改这三个变量。没配置时 `/api/asr` 返回 `503 asr_unavailable`，前端自动退回浏览器识别或文字作答。

配了 `HOSTED_LLM_TOKEN` 之后，访客在"模型接入"页会看到"本站已开启共享体验额度"，**API Key 留空即可直接开始面试**；额度用尽时接口返回 `429`（`code=hosted_quota_exceeded`），前端提示填写自己的 Key 并自动回退本地题库，不会白屏。

额度按访客隔离：某个访客当天用尽只影响他自己，其他社区访客照常可用。`/api/health` 的 `hostedLlm.dailyBudget` 会给出全站当日用量与上限（例如 `{"max":800,"used":213}`），可以用来判断"是不是该调大额度了"，而不必等访客来投诉。

登录之后额度**按账号计数**：同一个人换 IP、换网络都不会重置额度；只有未登录访客才退回按 IP 计数。想"注册个小号刷额度"也被每日注册名额（`SIGNUPS_PER_DAY`）挡住。

### 账号与数据：决定"换设备还能不能找回简历"

- 访客自助注册后，**简历存在服务端**（默认 `data/store.json`），浏览器 `localStorage` 只留一份只读缓存；换浏览器、换设备重新登录就能看到自己的简历。归属过滤放在存储层，账号之间互相看不到对方的简历。
- 口令只存 **scrypt 哈希**（随机盐 + 恒定时间比较），登录 token 只存 **sha256 摘要**：`store.json` 即使泄漏，也拿不到明文口令，也拿不到可直接使用的登录态。会话默认 30 天，点"退出登录"会把该会话从服务端删掉。
- **登录态走 `X-Auth-Token` 自定义头，不是 `Authorization: Bearer`**：ModelScope 的边缘网关会把带 `Authorization` 的请求直接回 `403`（实测：同一请求去掉这个头即正常转发到应用），症状就是"登录后一进下一屏被弹回登录页"——本项目早期版本踩过这个坑。`Authorization` 仍兼容（自建服务器/curl 可用），但前端不再发送。自查：`curl -s -H 'X-Auth-Token: <token>' https://<域名>/api/auth/me` 返回 200；同一请求改带 `Authorization` 会拿到 403，那是平台网关的拦截，不是应用的行为。
- 访客能自己处置数据：「面试记录」页底部有 **导出账号数据**（含简历）、**注销账号**（要求输入口令 + 二次确认，连简历一起删）、**清除本机缓存**。
- **跨容器重启能不能保住账号，取决于创空间给不给持久化目录**：容器本地可写层在重建/迁移后会丢。判断方法是启动日志里的一行：
  - `[store] 持久化已启用 -> <路径>`：正常，账号重启后仍在；
  - `[store] 持久化不可用（容器重启后账号与简历会丢失） -> <路径>`：目录不可写，已降级为**内存存储**，账号只在当次容器生命周期内有效（服务仍可用，但访客重启后会看到"账号不存在"）。`preflight` 里对应 `[WARN] 数据持久化：数据目录不可写或未挂载持久卷，容器重启后账号与简历会丢失（<原因>）`。
  把 `DATA_DIR` / `STORE_FILE` 指向平台提供的持久化目录（数据集、持久卷等）即可解决。
- `npm run preflight` 会一次性核这三件事：「账号体系」（部署的还是没有账号功能的旧镜像时直接 FAIL）、「数据持久化」、「认证边界」（未登录访问 `/api/auth/me` 或 `/api/resumes` 必须是 401）。
- 已知边界：存储层是**单进程 + 全量 JSON**，设计目标是"几百个账号 + 每账号几份简历"。真要多实例部署或上万账号，需要替换 `server/store.mjs` 的实现（路由与前端不用动）。

#### 平台确实没有持久卷时：不改代码，改说明

服务照常可用，代价是**账号只在当次容器生命周期内有效**。这种情况不要对社区承诺"账号长期保存"，而是在创空间说明里写清楚，并把数据出口交给访客自己——导出功能足以兜住这一点（实测：导出的 JSON 含简历原文，且不含口令哈希与登录 token）：

```text
账号数据说明（本空间没有持久化存储）：
· 账号与简历只保存在当前运行的容器里。平台重建或迁移容器后你的账号会失效，
  用同一个账号名重新注册即可继续使用（旧简历不会自动恢复）。
· 想换设备继续用、或担心容器被重建：请先在「面试记录」页底部点「导出账号数据」，
  保存导出的 JSON；新账号里把导出的简历文本重新粘贴一次即可。
· 想彻底删除自己的数据：同一位置点「注销账号」（需输入口令 + 二次确认），
  账号、会话与简历会一起从服务端删除。
```

一旦把 `DATA_DIR` / `STORE_FILE` 指向平台挂载的持久化目录，这段就可以整段删掉：启动日志会变成 `[store] 持久化已启用 -> <路径>`，`preflight` 的「数据持久化」也会从 `WARN` 变成 `PASS`。

## 5. 部署后自检

推荐直接跑自检脚本，它会把"创空间能不能给社区用"的关键项一次过完，退出码非 0 就代表有必须修的项：

```bash
npm run preflight -- https://<你的创空间域名>
```

期望输出（下面是本次实测的一次，托管 Key、ASR 三项与邀请码都配齐了；`WARN` 都有降级路径，不阻断部署，退出码仍为 0）：

```text
  [PASS] 接口存活：/api/health 返回 ok
  [PASS] 共享额度：已开启，单访客每日 40 次，模型 Qwen/Qwen3.5-35B-A3B
  [PASS] 当日额度余量：已用 0 / 800
  [PASS] 托管模型：Qwen/Qwen3.5-35B-A3B 在上游清单中
  [PASS] 语音播报：Edge TTS 可用
  [PASS] 语音识别：服务端识别已启用（FunAudioLLM/SenseVoiceSmall），访客无需自带 Key
  [PASS] 成本闸门：{"maxBodyBytes":12582912,"llmPerMinute":20,"asrPerMinute":20,"asrPerDay":600}
  [PASS] 账号体系：注册已开放（需要邀请码）；当前 0 个账号 / 0 份简历
  [PASS] 数据持久化：账号与简历已落盘（重启后仍在）
  [PASS] 认证边界 · 会话自检：不带 token 请求 /api/auth/me 返回 401
  [PASS] 认证边界 · 简历读取：不带 token 请求 /api/resumes 返回 401
  [PASS] 静态页面：GET / 返回 200
  [PASS] 页面挂载点：index.html 含 #root
  [PASS] 前端产物：已引用打包后的 JS

==== 14 PASS / 0 WARN / 0 FAIL ====
```

还没配的项会显示成 `WARN` 而不是 `FAIL`（本机未配置时实测 `10 PASS / 3 WARN / 0 FAIL`，末尾会给一行 `建议处理：共享额度、语音识别、注册防线`）：

- **共享额度**：没配 `HOSTED_LLM_TOKEN` 时提示"访客必须自带 API Key 才能用模型"，按第 4 节配好即 `PASS`。
- **语音识别**：缺 `ASR_BASE_URL` / `ASR_MODEL` / `ASR_TOKEN` 任一项时提示降级为浏览器识别或文字作答。
- **注册防线**：注册开放且没有邀请码时的提醒；设置 `SIGNUP_INVITE_CODE`（或 `ALLOW_SIGNUP=0`）后这行直接消失，不是故障。
- 「账号体系」出现"旧镜像"字样时**必须处理**；「数据持久化」出现 `WARN` 时账号重启即丢，见上面的「账号与数据」。

只想看服务端能力时，也可以直接读 `/api/health`（默认不发起任何外部请求；加 `?deep=1` 会额外核对一次上游模型清单，`npm run preflight` 走的就是这一条）：

```bash
curl -s -X POST "https://<你的创空间域名>/api/health?deep=1"
```

期望返回：

```json
{
  "ok": true,
  "tts": { "available": true, "reason": "" },
  "asr": { "available": true, "model": "FunAudioLLM/SenseVoiceSmall", "reason": "" },
  "accounts": {
    "signup": true,
    "inviteRequired": true,
    "sessionTtlDays": 30,
    "persistent": true,
    "reason": "",
    "users": 0,
    "resumes": 0
  },
  "hostedLlm": {
    "enabled": true,
    "model": "Qwen/Qwen3.5-35B-A3B",
    "perIpPerDay": 40,
    "dailyBudget": { "day": "2026-10-04", "used": 213, "max": 800 },
    "modelAvailable": true
  },
  "limits": { "maxBodyBytes": 12582912, "llmPerMinute": 20, "asrPerMinute": 20, "asrPerDay": 600 }
}
```

- `tts.available=false`：容器内没有可用的 `python3 + edge-tts`，语音播报会自动降级为浏览器内置 TTS，不影响流程。
- `accounts.persistent=false`：账号数据目录不可写，已降级为内存存储，容器重启后访客的账号与简历会丢；`reason` 里是底层原因。
- `accounts.inviteRequired=true`：注册需要邀请码（已设置 `SIGNUP_INVITE_CODE`）；`accounts.signup=false` 表示已用 `ALLOW_SIGNUP=0` 关闭注册。
- `hostedLlm.enabled=false`：没配托管 Key，访客需自带 Key 才能用模型提问（否则走本地题库）。
- `asr.available=false`：`reason` 会说明缺哪个变量；此时语音作答自动退回浏览器识别或文字作答。
- `hostedLlm.modelAvailable=false`：**必须处理**——配置的托管模型已不在上游清单里，访客会直接看到模型报错。响应里会带上 `availableModels`（同组织模型排在前面），换成其中一个即可；也可以直接 `HOSTED_LLM_MODEL=<在架模型>` 覆盖。

浏览器端建议再走一遍：登录 → 模型接入 → 简历分析 → 设备预检 → 文字面试 → 复盘报告。有 Chrome 的机器可以直接跑：

```bash
npm run build
npm start                      # 另开终端
NODE_PATH=$(npm root -g) npm run e2e     # Windows: $env:NODE_PATH = (npm root -g); npm run e2e
```

## 6. 访客会遇到的限制（建议写进创空间说明）

- **语音作答**会自动选引擎：配了 `ASR_*` 时任何支持 `MediaRecorder` 的现代浏览器都能录音作答；只有退回浏览器识别时才需要 Chromium 内核。创空间若以内嵌 iframe 打开，还需要宿主页面的 `allow="microphone; camera"`，否则浏览器直接拒绝；页面底部的提示条会说明并提供"在新窗口打开"。
- **摄像头**同理，失败不影响语音/文字作答。
- **登录是真实账号**：访客自助注册/登录，口令在服务端加盐哈希后存储，登录态默认 30 天。简历跟着账号走，换设备登录就能找回；账号之间互相看不到对方的简历。
- **账号与简历会落盘**：默认写在 `data/store.json`（可用 `DATA_DIR` / `STORE_FILE` 指向持久化目录）；面试历史仍以浏览器 `localStorage` 为主（最多 7 场），页面提供"导出账号数据""注销账号""清除本机数据"；服务端不保存面试内容，也不保存录音文件。
- **平台没有持久卷时**：账号与简历只在当次容器生命周期内有效，容器重建后需要重新注册；请把「平台确实没有持久卷时」那段模板粘进创空间说明，并保留"导出账号数据"的指引。
- **语音录音会外发**：语音作答时音频会发到本站 `/api/asr`，再转发给部署方配置的 ASR 上游转成文字（未配 ASR 时由浏览器自带的语音服务处理）。前端在开始语音面试前会先展示一次告知，访客须确认才能开始，也可以直接改用文字面试。
- 简历内容与回答会发送给所配置的模型服务（自带 Key 时是访客选的服务商，托管额度时是魔搭 API-Inference）。

可以把这个模板粘到创空间的说明里，把方括号换成实际情况：

```text
AI 模拟面试（社区体验版）

这是什么：按真实面试节奏推进的模拟面试。填岗位/简历 → 设备预检 → 语音或文字面试 →
结束后给出维度评分与逐题改进方案，保留最近 7 场做趋势对比。

怎么用：注册或登录一个账号（简历会保存到你的账号下，换设备登录还能找回）→
模型接入页留空即可用本站共享额度体验 → 简历可直接用预置示例 → 想做语音面试请用 Chrome/Edge，
并在新窗口打开；若被内嵌且没拿到麦克风权限，会自动降级为文字面试，不影响流程。

数据说明：
· 账号与简历保存在本站服务器[填写部署方]，口令加盐哈希存储、不存明文；「面试记录」页可导出账号数据，
  或注销账号（连简历一起删除）。
· 面试记录与设置主要存在你自己浏览器的 localStorage（最多 7 场），可一键清除本机缓存。
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
- 账号数据目录（`DATA_DIR` / `STORE_FILE`）已指向持久化位置；若平台确实没有持久卷，已在说明里写明"账号只在当次容器生命周期内有效"（可直接粘「平台确实没有持久卷时」那段现成文案）。`preflight` 的「数据持久化」不应出现 `WARN`。
- 注册防线已按需收紧（`ALLOW_SIGNUP` / `SIGNUP_INVITE_CODE` / `SIGNUPS_PER_DAY`），且 `preflight` 的「账号体系」「认证边界」两项为 `PASS`。
- 访客能自助导出与注销（合规）：入口在「面试记录」页底部，说明文案里也写明了账号数据的保留与删除方式。
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
