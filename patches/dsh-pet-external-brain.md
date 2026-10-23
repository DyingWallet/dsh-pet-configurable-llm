# dsh-pet × pet-brain：`externalBrain` 小补丁（未应用）

> 目的：在**不改大脑架构**的前提下，从结构上保证“桌宠不用它自己的 memory、失败也不回落成
> 普通模型”。只动 4 个文件，约 100–150 行（含测试）。
>
> 本文件是补丁说明，不是可直接 `git apply` 的 diff；应用前请先在 fork 里跑
> `pnpm typecheck && pnpm test`。仓库当前没有 `node_modules`，需要先准备 Node/pnpm。

## 为什么需要

仅靠配置（`chatMemoryRounds: 0`、`whisperEnabled: false`）已经能让它**不读**自己的记忆，
但还有两个口子：

1. `chatWithPet` 仍会把每轮对话写进 `memory.json`；文件会一直长，且 `GET /chat` 仍读它。
2. `generateChat` 在 `chatModel` 失败时会回落到“当前对话模型”重试一次——shim 挂了的时候，
   桌宠会用普通 DeepSeek 模型回答，看起来像桌宠，但不是那条 DSH 会话。

`externalBrain` 把这两处变成显式模式。

## 1. `src/host/config.ts`

在 `GLOBAL_DEFAULT_KEYS`（约 97 行）加一项：

```ts
const GLOBAL_DEFAULT_KEYS = [
  'physics',
  'font',
  'confineToScreen',
  'whisperImageEnabled',
  'chatImageEnabled',
  'chatImageLimit',
  'chatMemoryRounds',
  'whisperModel',
  'chatModel',
  'eventsRefreshSec',
  'externalBrain', // 新增：外部大脑模式（布尔，用户级）
] as const;
```

在 `fieldValid` 的 `switch`（约 400 行）加：

```ts
    case 'externalBrain':
      return typeof value === 'boolean';
```

用户层写 `"externalBrain": true` 才会生效；不写 = 旧行为。`saveUserConfig` 的白名单会跟着
`GLOBAL_DEFAULT_KEYS` 走，不需要另加。

## 2. `src/host/chat.ts`

签名加第 7 个参数 `strictPreferred = false`：

```ts
export async function generateChat(
  ctx: { agentDefaultModel: { currentSelection(): { provider: string; model: string } }; llm?: unknown },
  system: string,
  history: ChatMemoryMessage[],
  userText: string,
  pool: MemeEntry[] = [],
  preferred?: ModelRef,
  strictPreferred = false,
): Promise<ChatGenerateResult> {
  let candidates = modelCandidates(ctx, preferred);
  // 外部大脑模式：只认配置的 pet-brain，失败就报错，绝不回落到当前对话模型。
  if (strictPreferred && preferred) candidates = [preferred];
  ...
}
```

其余逻辑不动；候选链为空时仍回 `provider-missing`。

## 3. `src/host/whisper.ts`

同样加 `strictPreferred = false`（第 5 个参数），并在 `modelCandidates` 后：

```ts
  let candidates = modelCandidates(ctx, preferred);
  if (strictPreferred && preferred) candidates = [preferred];
```

自动碎碎念会被调度器跳过（见下），这个参数主要保护**手动** `/whisper` 不回落。

## 4. `src/host/index.ts`

### 4.1 `publishWhisper`（约 818 行）

```ts
const result = await generateWhisper(
  ctx,
  system,
  meme,
  configuredModel(found.conf, 'whisperModel'),
  found.conf.externalBrain === true,
);
```

### 4.2 `chatWithPet`（约 842 行）

```ts
const found = findPetInstance(cfg, petId);
if (!found) return { ok: false, reason: 'unknown-pet', message: '没有这只桌宠：' + petId };
const external = found.conf.externalBrain === true;
const rounds = memoryRounds(found.conf);
const system = petSystemPrompt(found);
const pool = ...;
const mem = external ? null : await readMemory();
const bucket = external ? null : (mem![found.entry] ??= {});
const entry = external ? null : (bucket![petId] ??= { messages: [] });
const list = external ? [] : sliceMemoryRounds(entry!.messages, rounds);
const generated = await generateChat(
  ctx, system, list, text, pool,
  configuredModel(found.conf, 'chatModel'),
  external,
);
if (!generated.ok) return generated;
if (!external) {
  const now = Date.now();
  entry!.messages.push({ role: 'user', content: text, ts: now });
  entry!.messages.push({ role: 'assistant', content: generated.text, ts: now });
  await writeMemory(mem!);
}
state.writePet(...);
```

> 注意：`withMemoryLock` 仍然保留（外部模式也不该并发写状态；而且 `GET /chat` 与写盘共用
> 同一把锁）。`mem` 为 null 时不要调用 `writeMemory`。

### 4.3 `GET /chat`（约 2231 行）

在 `const who = requirePet(...)` 之后加：

```ts
if (who.conf.externalBrain === true) {
  return { kind: 'json', status: 200, obj: { ok: true, messages: [], rounds: 0, external: true } };
}
```

这样它不会再读 `memory.json`，也不会在 UI 里显示旧记忆。

### 4.4 自动碎碎念调度（约 2634 行）

在 `if (!found) continue;` 之后加：

```ts
// 外部大脑模式下不自动碎碎念：每一次都是一整个 DSH agent turn，且会打断主会话节奏。
if (found.conf.externalBrain === true) continue;
```

配置里的 `whisperEnabled: false` 仍然建议保留（双重保险）；手动 `/whisper` 不受影响。

## 5. 测试

1. `src/host/config.test.ts`
   - `externalBrain: true` 通过；`externalBrain: "yes"` 报配置错误。
2. `src/host/model-fallback.test.ts`
   - 新增：`generateChat(ctx, ..., CONFIGURED, true)` 在 CONFIGURED 抛错时**不**调用当前模型
     （现有测试断言会回落；strict 断言只调用一次）。
3. `src/host/chat.test.ts` 或 `index` 路由测试
   - `GET /chat` 在 `externalBrain` 下返回空 messages，且不读 `memory.json`。
4. 手动验收
   - 清空 `memory.json` → 问桌宠一个 `memories/` 里的旧事实 → 仍答对。
   - 停掉 pet-brain → 问桌宠 → 应显示“对话失败”，而不是普通模型回答。

## 6. 应用顺序

```powershell
# 1) 先在 fork 里准备 Node/pnpm 并安装依赖
pnpm install
pnpm typecheck
pnpm test

# 2) 改完四个文件后
pnpm build
# 3) 桌面版只能在应用内「插件管理」安装本地构建；或按 README 的 file: 方式走 web profile
```

## 7. 回滚

`externalBrain` 默认 `false`，删掉用户层的 `"externalBrain": true` 即回到旧行为；
`memory.json` 可提前备份，脚本不会删它。
