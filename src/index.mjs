// pet-brain 入口：
//   node src/index.mjs           启动 OpenAI 兼容服务
//   node src/index.mjs --check   只体检（配置/记忆卡/DSH/preset），不起服务
import { loadConfig } from './config.mjs';
import { createLogger } from './logger.mjs';
import { buildMemoryCard } from './memory-card.mjs';
import { createMemoryService } from './memory.mjs';
import { patchDshPetClient } from './patch-dsh-pet.mjs';
import { DshBrain } from './dsh.mjs';
import { createPetBrainServer } from './server.mjs';

const CHECK = process.argv.includes('--check');

const loaded = loadConfig({ logger: console });
if (process.env.PET_BRAIN_PRESET) loaded.config.dsh.agentPreset = process.env.PET_BRAIN_PRESET;
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

let card = buildMemoryCard({
  root: loaded.config.memory.root,
  cardFile: loaded.config.memory.cardFile,
  maxChars: loaded.config.memory.maxChars,
  name: loaded.config.identity.name,
});
const memory = {
  getCard: () => card,
  refresh: () => {
    card = buildMemoryCard({
      root: loaded.config.memory.root,
      cardFile: loaded.config.memory.cardFile,
      maxChars: loaded.config.memory.maxChars,
      name: loaded.config.identity.name,
    });
    logger.info(`记忆卡已刷新：${card.chars} 字，${card.files.length} 个来源`);
    return card;
  },
};

logger.info(`配置：${loaded.configPath}`);
logger.info(`记忆卡：${card.chars} 字，${card.files.length} 个来源 -> ${loaded.config.memory.cardFile}`);
logger.info(`模型：${Object.keys(loaded.config.models).join(', ')}（默认 ${loaded.config.defaultModel}）`);

if (CHECK) {
  const brain = new DshBrain({ config: loaded.config, logger, stateDir: loaded.stateDir });
  const health = await brain.health().catch((error) => ({ reachable: false, error: error?.message ?? String(error) }));
  await brain.close();
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
        memoryCard: { chars: card.chars, files: card.files, file: loaded.config.memory.cardFile },
        dsh: health,
        listen: loaded.config.listen,
      },
      null,
      2,
    ),
  );
  process.exit(health.reachable === true && presetReady ? 0 : 2);
}

const brain = new DshBrain({ config: loaded.config, logger, stateDir: loaded.stateDir });
await brain.start();

const memoryService = createMemoryService(loaded.config, logger);
logger.info(`记忆服务：${memoryService.endpoint}（scene=${memoryService.scene}，令牌 ${memoryService.tokenFile}）`);

const server = createPetBrainServer({
  config: loaded.config,
  logger,
  brain,
  memory,
  memoryService,
  token: loaded.token,
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(loaded.config.listen.port, loaded.config.listen.host, resolve);
});
logger.info(`pet-brain 已监听 http://${loaded.config.listen.host}:${loaded.config.listen.port}/v1`);
logger.info(`令牌文件：${loaded.tokenFile}`);
logger.info(`DSH preset：${loaded.config.dsh.agentPreset}；工作区：${loaded.config.dsh.workspacePath}`);

const refreshTimer = setInterval(() => {
  try {
    memory.refresh();
  } catch (error) {
    logger.warn(`记忆卡定时刷新失败：${error?.message ?? error}`);
  }
}, loaded.config.memory.refreshMs);
refreshTimer.unref?.();

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  logger.info(`收到 ${signal}，正在关闭…`);
  clearInterval(refreshTimer);
  await new Promise((resolve) => server.close(() => resolve()));
  await brain.close();
  logger.info('已关闭');
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (error) => {
  logger.error(`未处理的 Promise 拒绝：${error?.stack ?? error}`);
});
