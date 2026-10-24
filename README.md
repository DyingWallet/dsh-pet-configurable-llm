# dsh-pet-configurable-llm —— 桌宠的「LLM」接入层

> 项目名：`dsh-pet-configurable-llm`（可配置的 dsh-pet LLM 接入层）。  
> DSH 里的 provider ID 仍是 `pet-brain`（兼容现有 `chatModel: pet-brain/xi`），改名只涉及仓库与目录，不动运行中的模型 ID。  
> 代码标识符统一用 LLM/agent 的说法（`DshAgent`、`createPetLlmServer`、`PET_LLM_*`），
> 只有两处保留旧名：provider ID `pet-brain`（对外契约）和旧补丁标记 `petBrainReplyPriority` /
> `.bak-petbrain`（兼容已打过补丁的文件，见 `src/patch-dsh-pet.mjs`）。

把 `dsh-pet` 的对话/碎碎念接到**同一个工作区里的专用 DSH 会话**，让桌宠复用工作区的
`AGENTS.md` 人格、`memories/` 长期记忆和同一个模型账户；它自己的
`memory.json` 不再参与生成。

```
桌宠 UI ──POST /chat──▶ dsh-pet host ──ctx.llm──▶ DSH 自定义 provider「pet-brain」
                                                   │
                                            本服务（OpenAI 兼容 /v1）
                                                   │
                                    专用 DSH 会话（workspace=D:\deepseek_workspace）
                                    preset=pet-chat（只读工具）
                                    └─ AGENTS.md + memories/ + 记忆卡
```

## 它解决什么

- **不是**“把模型换成 DeepSeek”——桌宠本来就用当前 DSH 模型；这里换的是**会话身份**：
  同一个工作区、同一份 `AGENTS.md`、同一份 `memories/`，以及一条能在 DSH 里打开审计的会话。
- 桌宠的 `memory.json` 不进入上下文（`chatMemoryRounds: 0`）；真正的记忆是
  `memories/` + 那条 DSH 会话。
- 桌宠只是“嘴和身体”：气泡、动画、工作状态仍由 `dsh-pet` 管；模型会话在 DSH 里。

## 前置

- Windows，DSH 桌面版 **0.2.1-rc.2**（见下节；其它版本未验证）。
- Node.js ≥ 22.12。本机 PATH 没有 node 时，用 DSH 自带的：
  `D:\Software\dsh\resources\runtime\primary-runtime\dependencies\node\bin\node.exe`
- `qq-agent-presets` 插件（`pet-chat` preset 复用它提供的只读工具守卫）。
- 本服务依赖 `..\qq-bridge\src\dsh-client.js`（Cookie 铸造、端口发现、session RPC），
  所以 `qq-bridge` 目录要保留在同级。

## DSH 版本支持

**目前仅支持 DSH 桌面版 `0.2.1-rc.2`。** 其它版本未做验证，升级后请先自检：

```powershell
node src\index.mjs --check
```

为什么绑得这么紧——本服务吃的是 DSH 的**未公开 RPC 形态**，不是稳定协议：

| 依赖点 | 在 0.2.1-rc.2 的形态 |
|---|---|
| `session/prompt` | 必须带 `requestId`；`mode: 'queue'` |
| `session/selectModel` | 选完模型后 `reasoningEffort` 由 DSH 决定 |
| `session/projections` | 队列/权限/token 用量都从这里读 |
| `agentPresets.list` | preset 存在才能建会话（`pet-chat`） |
| `commands.execute` | `/permission read-only` 走这条 |
| `turn/end` 的 reason | `{kind: completed\|aborted|error\|blocked}`；**`blocked` 没有 message** |

升级 DSH 后如果桌宠开始报错或只回降级文案，先看 `logs/pet-llm.log` 里的 `reason`：
`blocked` 见 `memories/50-knowledge/2026-10-24-pet-blocked-session.md`，`error` 才是网络/进程问题。

## 安装（三步）

### 1. 安装 pet-chat preset

```powershell
# 先 dry-run，确认目标与备份路径
powershell -ExecutionPolicy Bypass -File scripts\apply-preset.ps1
# 确认后写入 profile patch
powershell -ExecutionPolicy Bypass -File scripts\apply-preset.ps1 -Apply
```

然后**重启 DSH 桌面版**（插件/preset 变更必须重启）。重启后：

```powershell
# 本机 PATH 没有 node 时用这个包装（会自动找 DSH 自带 Node）
powershell -ExecutionPolicy Bypass -File scripts\check.ps1
# 或直接：
& 'D:\Software\dsh\resources\runtime\primary-runtime\dependencies\node\bin\node.exe' src\index.mjs --check
```

`--check` 会生成 `state/token.txt`（即使 `presetReady` 还是 false，也可以先拿 token）。
`presetReady` 必须是 `true`。回滚：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\rollback-preset.ps1
# 或从备份恢复
powershell -ExecutionPolicy Bypass -File scripts\rollback-preset.ps1 -Restore
```

### 2. 在 DSH 里添加自定义 provider

DSH 设置 → 模型 → 添加自定义提供方（或直接写 `settings.yaml` 的 `llm-pi-ai`）：

| 字段 | 值 |
|---|---|
| Provider ID | `pet-brain` |
| 显示名称 | 桌宠 |
| 基础 URL | `http://127.0.0.1:8790/v1` |
| API 协议 | `openai-completions` |
| 凭据 / API Key | `state/token.txt` 里的那串（首次启动生成） |
| 模型 | id `xi`，名称 `桌宠` |
| 超时 | 55000 ms（低于桌宠 /chat 的 60s） |

`settings.yaml` 等价写法（按你机器上的 DSH 版本字段为准）：

```yaml
llm-pi-ai:
  providers:
    pet-brain:
      displayName: 桌宠
      api: openai-completions
      baseURL: http://127.0.0.1:8790/v1
      apiKeyEnv: PET_LLM_KEY   # 或在 UI 里保存凭据
      timeoutMs: 55000
      compat:
        supportsDeveloperRole: false
        maxTokensField: max_tokens
      models:
        - id: xi
          name: 桌宠
```

> 不要把 `pet-brain` 设成 DSH 的**默认模型**：那会让本服务里的 DSH 会话再调回本服务，
> 形成自我递归。它只给桌宠的 `chatModel` 用。
>
> 建议把该路由的重试调低（`retryPolicy.maxRetries: 0` 或 `1`）：DSH 超时后自动重试会
> 对同一条会话再发一次 prompt，产生重复的 agent turn。

### 3. 配置桌宠

编辑 `$DSH_HOME\dsh-pet\main-config.jsonc`（或设置页）把全局默认改成：

```jsonc
{
  "chatModel": { "provider": "pet-brain", "model": "xi" },
  "whisperModel": { "provider": "pet-brain", "model": "xi" },
  "chatMemoryRounds": 0,
  "pets": [
    {
      "id": "main",
      "whisperEnabled": false
      // …其余字段保持原样
    }
  ]
}
```

- `chatMemoryRounds: 0`：桌宠的 `memory.json` 不再进上下文。
- `whisperEnabled: false`：关掉每 300 秒自动碎碎念（否则每 5 分钟烧一个 agent turn）。
  手动右键「碎碎念」/`/chat` 空参数仍可用，走同一个 LLM 会话。
- 如果设置页的下拉框暂时看不到 `pet-brain/xi`，直接改 `main-config.jsonc` 也能生效
  （配置校验只要求 provider/model 都非空）。

## 启动与验证

```powershell
# 启动（前台；建议用计划任务/隐藏窗口在登录时启动）
& 'D:\Software\dsh\resources\runtime\primary-runtime\dependencies\node\bin\node.exe' src\index.mjs

# 另开一个终端：
curl http://127.0.0.1:8790/health
& 'D:\...\node.exe' tools\pet.mjs state
& 'D:\...\node.exe' tools\pet.mjs chat "在吗"
```

### 验“里面是不是我”

1. **长期记忆**：问桌宠「QQ 桥接的启动链有哪几段？」它应能说出
   `start-stack.ps1` / SnowLuma / hook / 桥接（来自 `50-knowledge/`，不在记忆卡里，
   必须真的用 `read`/`grep` 查）。
2. **身份暗号**：问「暗号是什么？」它应回答 `海盐柠檬 0423`
   （来自 `memories/.meta/identity-canary.md`；答不出=没读到记忆）。
3. **清空它自己的记忆**：备份并清空 `$DSH_HOME\dsh-pet\memory.json`，再问上面任意一题。
   答对 = 没有依赖桌宠自己的 memory。
4. **审计**：在 DSH 会话列表里打开「桌宠 LLM」，能看到这轮对话与工具调用。

## 记忆卡

- 服务启动时生成 `memories/.meta/pet-memory-card.md`，内容 = profile / preferences /
  index / 最近 2 篇日志 / 项目 / 近期决策 / 相关的人 / `00-inbox/live-context.md`。
- 第一条消息把它作为“启动卡”注入；之后同一会话不再重复注入。
- 定时刷新（默认 10 分钟）与会话重置后重新注入；也可 `POST /admin/memory/refresh`。
- 需要细节时，`pet-chat` 的只读工具会去读 `memories/index.md` 指向的原文件。

> 这张卡是**长期记忆**，不是这条主会话的实时上下文。主会话里刚发生的事，要等写进
> `memories/`（journal / live-context）之后桌宠才知道。想让它知道“现在”，可以让助手在
> 关键节点往 `memories/00-inbox/live-context.md` 追加一行。

## dsh-pet 气泡优先级自愈

dsh-pet 的气泡位只有一个，回合结束时「工作状态」气泡（“任务完成啦”等）会优先占位，盖住刚到的回复。

本服务启动时会自动给已安装的 dsh-pet 打补丁（`src/patch-dsh-pet.mjs`），**网页和桌面 helper 两套渲染栈都改**：

- 网页 `lib/client.js`：两个工作状态分支加 `&& !(whisperBubbleOn && whisperText)`；
- 桌面 `runtime/electron-helper/sprite.js`：bubble slot 改成 `whisperOn ? 'whisper' : workTerminal && workOn ? 'work' : ...`；
- 幂等（`petLlmReplyPriority` 标记，同时认旧标记 `petBrainReplyPriority`），首次修改前各自备份
  `.bak-petllm`（旧的 `.bak-petbrain` 也认）；
- dsh-pet 升级后下次启动自动重打；匹配不到只记 warning。

生效：网页刷新即可；**桌面 helper 需要重启 DSH**（helper 进程启动时才读 `sprite.js`）。

## 记忆服务（memd）

除记忆卡之外，本服务还接 `memory-hub`（`memd`）：

- `src/memory.mjs`：每轮 `POST /v1/recall`（scene=`pet`）把相关记忆拼在 prompt 最前；同时 `POST /v1/ingest` 上报用户消息与回复（短期层，50 条/批，失败静默）。
- 令牌在 `state/memory.token`（surface `pet`，scopes `main/qq:owner/pet`，无 `work:read`）。
- 可见范围：owner 的 `main`/`qq:owner` + shared；**不含**工作/财务、群、第三人私聊。
- 配置段：

```jsonc
"memoryService": {
  "endpoint": "http://127.0.0.1:8787",
  "tokenFile": "D:/deepseek_workspace/dsh-pet-configurable-llm/state/memory.token",
  "scene": "pet",
  "recallK": 3,
  "recallMaxChars": 800,
  "timeoutMs": 800,
  "ingest": true
}
```

- memd 不在线时静默降级：没有记忆块，但桌宠照常回复。
- 验证：`node test/run-all.mjs`（含「召回块进 prompt、用户与回复都入库」用例）。

## 安全边界

- 只监听 `127.0.0.1`；所有 `/v1` 请求要 `Authorization: Bearer <state/token.txt>`。
- `pet-chat` preset 只有 `read / read_image / glob / grep / web_search / web_fetch`；
  没有 shell、write/edit、subagent、MCP 资源读取。
- 复用 `qq-agent-presets` 的 `qq-tool-restrict`（`readonly-agent`）与 protected-paths：
  `.credentials.yaml`、桥接 state、`sessions.json` 等读取会被拒绝。
- 桌宠的 `/dsh-pet-7340` 本身无鉴权、只绑回环；不要把 8790 或 DSH 端口转发到公网。
- 本服务日志不写 token、cookie、消息正文。

## 运维

| 项 | 位置/命令 |
|---|---|
| 配置 | `config.json`（首次可复制 `config.example.json`） |
| 令牌 | `state/token.txt`（首次启动生成，可手工换） |
| 会话映射 | `state/sessions.json`（petId → DSH sessionId） |
| 日志 | `logs/pet-llm.log` |
| 健康 | `GET /health`（无需令牌） |
| 重置某只宠物的 LLM 会话 | `POST /admin/sessions/reset` `{ "petId":"main" }`（需令牌） |
| 刷新记忆卡 | `POST /admin/memory/refresh`（需令牌） |
| 自检 | `node src/index.mjs --check` |
| 看护（1 分钟） | `scripts\install-revive-task.ps1` 注册任务 `pet-revive`；`-Check` 看状态，`uninstall-revive-task.ps1` 删除。它在「DSH 在、8790 不在」时拉起本服务，日志 `logs/revive.log` |
| 进程自退 | DSH 连续 3 x 20 秒不可达即退出（`src/guard.mjs`），`PET_LLM_ORPHAN_GUARD=0` 可关 |
| 失败降级 | 内部失败时返回 200 + 一句说明（`src/degraded.mjs`），避免 dsh-pet 回落到普通对话模型；`PET_LLM_DEGRADED_REPLY=0` 可退回 502 |

DSH 桌面版每次重启换随机端口：`dsh.baseUrl` 留空时本服务会自动发现；固定端口失效时会
再扫一次。`DSH_WEB_URL` 环境变量优先。

## 已知限制（下一步）

1. **重入未在桌宠插件内实测**：桌宠的 LLM 请求在 DSH 宿主进程里发出，本服务又回调同一个
   DSH。理论上异步不阻塞，但需要装好桌宠后跑一次真实链路；若卡住，退到独立 app 或第二个
   DSH 实例。
2. **桌宠的通知/工作状态**：专用 DSH 会话也会发 `turn/start`、`turn/end`，桌宠可能为自己的
   回复弹通知/切状态。需要时按 sessionId 过滤（`notify-events` / `work-status`）。
3. **流式粒度**：目前按 `assistant/message` 整段下发（SSE 仍是合法的流），没有逐 token；
   桌宠气泡本来也是整段出现，够用。
4. **表情包选图**：桌宠的 `chatImageEnabled` 暂关；要保留需把 meme 清单交给 DSH 会话，
   或由本服务在回复后补 `[图:名称]`。
5. **实时上下文**：只接长期记忆；要接“这条主会话最近说了什么”，需要额外读 session 日志/
   写 live-context（+1–2 天）。
6. **严格 identity**：未改 `dsh-pet` 源码时，shim 失败会触发它的“回落当前模型”重试。
   现在由本服务的降级文案挡住（`src/degraded.mjs`，失败时返回 200 + 一句说明，它就不会去试
   第二个候选）；`patches/dsh-pet-external-llm.md` 是当时评估的另一种做法，**已作废**，
   仅留作记录。

## 目录

```
dsh-pet-configurable-llm/
  config.example.json / config.json
  src/
    index.mjs        入口/体检
    config.mjs       配置与令牌
    memory-card.mjs  记忆卡生成
    dsh.mjs          DSH 会话/事件流
    server.mjs       OpenAI 兼容 HTTP
  preset/pet-chat.patch.yml
  scripts/apply-preset.ps1 / rollback-preset.ps1
  tools/pet.mjs      桌宠控制 CLI
  test/              单元测试 + 真实 DSH 集成测试
  patches/           dsh-pet fork 补丁说明
```
