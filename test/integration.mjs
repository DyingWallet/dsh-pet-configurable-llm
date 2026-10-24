// 真实 DSH 集成测试（可选）：建一条 qq-agent-readonly 会话，让它读 memories/ 回答问题，
// 然后归档会话。需要 DSH 正在运行；会临时创建/归档一条会话。
//
// 用法：
//   node test/integration.mjs
//
// 为什么用 qq-agent-readonly 而不是 pet-chat：pet-chat 还没安装（需要改 profile + 重启 DSH）。
// 这个脚本验证的是同一条链路：workspace + 只读工具 + memories 读取 + prompt/turn 事件。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { createLogger } from '../src/logger.mjs';
import { buildMemoryCard } from '../src/memory-card.mjs';
import { DshBrain } from '../src/dsh.mjs';

const loaded = loadConfig({ logger: console });
loaded.config.dsh.agentPreset = process.env.PET_BRAIN_TEST_PRESET || 'qq-agent-readonly';
loaded.config.dsh.timeoutMs = 90_000;
loaded.config.log.level = 'debug';
const logger = createLogger(loaded.config.log);
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-llm-integration-'));

const card = buildMemoryCard({
  root: loaded.config.memory.root,
  cardFile: loaded.config.memory.cardFile,
  maxChars: loaded.config.memory.maxChars,
});
logger.info(`记忆卡 ${card.chars} 字；preset=${loaded.config.dsh.agentPreset}`);

const brain = new DshBrain({ config: loaded.config, logger, stateDir });
let ok = false;
try {
  await brain.start();
  const question =
    '先用 read 读 memories/50-knowledge/2026-10-22-qq-bridge-deployed.md，' +
    '再用一句话回答：QQ 桥接的启动链有哪几段？不要编，读不到就说读不到。';
  const result = await brain.prompt('selftest', question);
  console.log('--- 回答 ---');
  console.log(result.text);
  console.log('--- 结果 ---', result.ok, result.reason);
  ok = result.ok && /start-stack|SnowLuma|桥接|hook/i.test(result.text);
  if (!ok) console.error('集成测试失败：回答里没有启动链关键词');

  if (ok) {
    const canary = await brain.prompt(
      'selftest',
      '读 D:\\deepseek_workspace\\memories\\.meta\\identity-canary.md，只回答里面的暗号原文（四个字+数字），不要解释。',
    );
    console.log('--- 暗号回答 ---');
    console.log(canary.text);
    ok = canary.ok && /海盐柠檬\s*0423/.test(canary.text);
    if (!ok) console.error('集成测试失败：暗号没有读到');
  }
} catch (error) {
  console.error('集成测试异常：', error?.stack ?? error);
} finally {
  try {
    await brain.resetSession('selftest');
  } catch (error) {
    console.error('归档测试会话失败：', error?.message ?? error);
  }
  await brain.close();
  fs.rmSync(stateDir, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
