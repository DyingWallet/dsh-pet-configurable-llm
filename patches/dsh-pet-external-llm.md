# 历史记录：给 dsh-pet 打「外部 LLM 模式」补丁（**已作废，不要做**）

> 2026-10-24 决定：**不碰 dsh-pet 的源码**，这件事改在本服务里做完了。本文只留作调查记录，
> 里面的做法不要再应用。

## 当时想解决什么

仅靠配置（`chatMemoryRounds: 0`、`whisperEnabled: false`）已经能让桌宠**不读**自己的
`memory.json`，但还有两个口子：

1. `chatWithPet` 仍会把每轮对话写进 `memory.json`（文件会一直长，`GET /chat` 还会读它）；
2. `generateChat` 在 `chatModel` 失败时会回落到「当前对话模型」重试一次——本服务挂了的时候，
   桌宠会用普通 DeepSeek 模型回答，看起来像桌宠，但不是那条 DSH 会话。

当时的思路是在 dsh-pet 里加一个用户级布尔开关 + 四个文件的改动（配置白名单、`generateChat`
和 `generateWhisper` 加 strict 参数、`chatWithPet` 跳过记忆读写、自动碎碎念跳过、`GET /chat`
返回空历史），约 100–150 行含测试。

## 为什么放弃

- **要改第三方插件的源码**：dsh-pet 是 npm 上的插件（本机 0.3.8），改了要重新构建、装本地包，
  升级一次就覆盖，还得自己维护 fork；
- **两个口子都能在我们这侧解决**（见下），没必要动别人的代码。

## 现在的做法

1. **失败不回落** → `src/degraded.mjs`：本服务内部失败时返回 HTTP 200 + 一句明确的降级文案，
   dsh-pet 收到的是「成功生成」，不会再去试第二个候选模型。
   关掉办法：`degradedReply.enabled=false` 或 `PET_LLM_DEGRADED_REPLY=0`（退回原来的 502）。
2. **进程不在的那一半** → `scripts/revive.mjs` + `scripts/install-revive-task.ps1`（任务
   `pet-revive`，每 1 分钟）：DSH 在、8790 不在就把服务拉起来。之前 `start-stack.ps1` 只在登录时
   跑一次，DSH 重启后没人补。
3. **不用自己的 `memory.json`** → 本来就成立：`sliceMemoryRounds` 在 `rounds = 0` 时直接返回空数组，
   `readMemory()` 只有 `chatWithPet`（写入）和 `GET /chat`（给 UI 显示历史）两个调用点，
   都不参与生成。文件不累积也就不再管它。

## 原方案的四个文件（供参照，不要照做）

- `src/host/config.ts`：把新开关加进全局默认键白名单 + 类型校验；
- `src/host/chat.ts`：`generateChat` 加 strict 参数，只保留配置的模型候选；
- `src/host/whisper.ts`：同上，保护手动 `/whisper`；
- `src/host/index.ts`：`publishWhisper` / `chatWithPet` / `GET /chat` / 自动碎碎念四处接上开关。
