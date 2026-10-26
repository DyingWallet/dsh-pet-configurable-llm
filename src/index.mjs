// 模型服务入口：
//   node src/index.mjs           启动 OpenAI 兼容服务
//   node src/index.mjs --check   只体检（配置/记忆卡/DSH/preset），不起服务
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { createLogger } from './logger.mjs';
import { createMemoryService } from './memory.mjs';
import { patchDshPetClient } from './patch-dsh-pet.mjs';
import { DshAgent } from './dsh.mjs';
import { createDshGuard } from './guard.mjs';
import { createPetLlmServer } from './server.mjs';

const CHECK = process.argv.includes('--check');

const loaded = loadConfig({ logger: console });
if (process.env.PET_LLM_PRESET) loaded.config.dsh.agentPreset = process.env.PET_LLM_PRESET;
const logger = createLogger(loaded.config.log);

// dsh-pet 的气泡优先级：让回复压过工作状态（启动时自动、幂等，网页 + 桌面两套）。
try {
  const patch = patchDshPetClient({ profile: loaded.config.dsh.profile, logger });
  for (const [label, result] of [
    ['client', patch.client],
    ['desktop helper', patch.sprite],
  ]) {
    if (result.status === 'patched') logger.info(`dsh-pet ${label} 回复优先级补丁已应用：${result.file}`);
    else if (result.status === 'unsupported') logger.warn(`dsh-pet ${label} 补丁未匹配（版本可能变了）：${result.file}`);
  }
} catch (error) {
  logger.warn(`dsh-pet 回复优先级补丁失败：${error?.message ?? error}`);
}

logger.info(`配置：${loaded.configPath}`);
logger.info(`模型：${Object.keys(loaded.config.models).join(', ')}（默认 ${loaded.config.defaultModel}）`);

if (CHECK) {
  const agent = new DshAgent({ config: loaded.config, logger, stateDir: loaded.stateDir });
  const health = await agent.health().catch((error) => ({ reachable: false, error: error?.message ?? String(error) }));
  await agent.close();
  const presetReady = Array.isArray(health.presets) && health.presets.includes(loaded.config.dsh.agentPreset);
  console.log(
    JSON.stringify(
      {
        ok: health.reachable === true && presetReady,
        presetReady,
        configPath: loaded.configPath,
        tokenFile: loaded.tokenFile,
        workspacePath: loaded.config.dsh.workspacePath,
        preset: loaded.config.dsh.agentPreset,
        dsh: health,
        listen: loaded.config.listen,
      },
      null,
      2,
    ),
  );
  process.exit(health.reachable === true && presetReady ? 0 : 2);
}

const agent = new DshAgent({ config: loaded.config, logger, stateDir: loaded.stateDir });
await agent.start();

const memoryService = createMemoryService(loaded.config, logger);
logger.info(`记忆服务：${memoryService.endpoint}（scene=${memoryService.scene}，令牌 ${memoryService.tokenFile}）`);

const server = createPetLlmServer({
  config: loaded.config,
  logger,
  agent,
  memoryService,
  token: loaded.token,
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(loaded.config.listen.port, loaded.config.listen.host, resolve);
});
logger.info(`模型服务已监听 http://${loaded.config.listen.host}:${loaded.config.listen.port}/v1`);
logger.info(`令牌文件：${loaded.tokenFile}`);
logger.info(`DSH preset：${loaded.config.dsh.agentPreset}；工作区：${loaded.config.dsh.workspacePath}`);

// 记下自己用的 node 运行时：doctor 靠它判断有没有服务还在用 DSH 自带的 node.exe
// （那会锁住 DSH 安装目录，升级时改名失败 WinError 32）。
try {
  writeFileSync(
    path.join(loaded.stateDir, 'runtime.json'),
    `${JSON.stringify({ service: 'pet-llm', node: process.execPath, version: process.version, pid: process.pid, startedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  );
} catch {
  // 只影响自检
}

// 孤儿保护：本服务由 start-stack.ps1 在 DSH 之后拉起，不做独立登录任务。
// DSH 关闭/崩溃后连续 3 次探活失败（默认 20 秒一次，约 60 秒）就退出，
// 免得留下占着 8790 的僵尸后端。PET_LLM_ORPHAN_GUARD=0 可关掉（本地调试用）。
const orphanGuard = createDshGuard({
  probe: () => agent.probe(),
  logger,
  probeMs: loaded.config.lifecycle.probeMs,
  maxMisses: loaded.config.lifecycle.maxMisses,
  onOrphan: () => shutdown('orphan'),
});
const guardEnabled = loaded.config.lifecycle.orphanGuard && process.env.PET_LLM_ORPHAN_GUARD !== '0';
if (guardEnabled) orphanGuard.start();
else logger.warn('孤儿保护已关闭（lifecycle.orphanGuard=false 或 PET_LLM_ORPHAN_GUARD=0）');

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  logger.info(`收到 ${signal}，正在关闭…`);
  orphanGuard.stop();
  await new Promise((resolve) => server.close(() => resolve()));
  await agent.close();
  logger.info('已关闭');
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (error) => {
  logger.error(`未处理的 Promise 拒绝：${error?.stack ?? error}`);
});
