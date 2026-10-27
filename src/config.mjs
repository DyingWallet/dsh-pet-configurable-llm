// 配置加载：默认值 <- config.json <- 环境变量。
// 密钥不写进 config.json：首次启动生成 state/token.txt，DSH 的自定义 provider 把
// 这个 token 填进 API Key 即可。配置文件里只放非机密参数。
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULTS = {
  identity: { name: '桌宠' },
  listen: { host: '127.0.0.1', port: 8790 },
  dsh: {
    baseUrl: '',
    workspacePath: 'D:/deepseek_workspace',
    agentPreset: 'pet-chat',
    fallbackPreset: '',
    model: { provider: 'deepseek-account', model: 'deepseek-flash' },
    timeoutMs: 55_000,
    rediscoverMs: 15_000,
  },
  memory: { root: '' },
  memoryService: {
    endpoint: 'http://127.0.0.1:8787',
    tokenFile: '',
    scene: 'pet',
    recallK: 5,
    recallMaxChars: 1500,
    // 最近写下的长期记忆（recall 不擅长「最近发生了什么」，这路补上）。
    recent: { k: 5 },
    timeoutMs: 800,
    ingest: true,
  },
  // 孤儿保护：本服务跟着 DSH 生命周期（v2 自启方案 B）。3 次 x 20 秒 = 60 秒。
  lifecycle: { orphanGuard: true, probeMs: 20_000, maxMisses: 3 },
  // 失败时的降级文案（见 degraded.mjs）：返回 200 + 这句话，dsh-pet 就不会回落到普通模型。
  degradedReply: { enabled: true, text: '' },
  models: { xi: 'main' },
  defaultModel: 'xi',
  log: { level: 'info', file: '' },
};

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function merge(base, patch) {
  if (!isObject(patch)) return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = isObject(value) && isObject(base?.[key]) ? merge(base[key], value) : value;
  }
  return out;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw new Error(`无法读取配置 ${file}: ${error?.message ?? error}`);
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readOrCreateToken(stateDir, logger) {
  const file = path.join(stateDir, 'token.txt');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 16) return existing;
  } catch {
    // 首次启动
  }
  const token = randomBytes(32).toString('base64url');
  ensureDir(stateDir);
  fs.writeFileSync(file, token + '\n', { mode: 0o600 });
  logger?.warn?.(`已生成新的本地访问令牌：${file}（只给本机的 DSH 自定义 provider 用，不要外传）`);
  return token;
}

function normalizeConfig(raw, logger) {
  const cfg = merge(DEFAULTS, raw);
  if (!isObject(cfg.identity)) cfg.identity = { ...DEFAULTS.identity };
  cfg.identity.name = String(cfg.identity.name || DEFAULTS.identity.name).trim() || DEFAULTS.identity.name;
  if (!isObject(cfg.listen) || typeof cfg.listen.port !== 'number') throw new Error('listen.port 必须是数字');
  if (cfg.listen.host !== '127.0.0.1' && cfg.listen.host !== 'localhost') {
    logger?.warn?.('listen.host 不是回环地址；模型服务没有公网防护，建议改回 127.0.0.1');
  }
  if (!Number.isInteger(cfg.listen.port) || cfg.listen.port < 1 || cfg.listen.port > 65535) {
    throw new Error('listen.port 必须是 1–65535 的整数');
  }
  if (!isObject(cfg.dsh)) throw new Error('dsh 必须是对象');
  cfg.dsh.workspacePath = String(cfg.dsh.workspacePath || DEFAULTS.dsh.workspacePath);
  cfg.dsh.agentPreset = String(cfg.dsh.agentPreset || '');
  if (!cfg.dsh.agentPreset) throw new Error('dsh.agentPreset 不能为空（fail-closed，绝不回退到 standard）');
  if (!Number.isFinite(cfg.dsh.timeoutMs) || cfg.dsh.timeoutMs < 5_000 || cfg.dsh.timeoutMs > 120_000) {
    throw new Error('dsh.timeoutMs 必须是 5000–120000 的毫秒数');
  }
  if (!isObject(cfg.memory)) throw new Error('memory 必须是对象');
  cfg.memory.root = path.resolve(cfg.memory.root || path.join(cfg.dsh.workspacePath, 'memories'));
  if (!isObject(cfg.memoryService)) throw new Error('memoryService 必须是对象');
  cfg.memoryService.endpoint = String(cfg.memoryService.endpoint || DEFAULTS.memoryService.endpoint).replace(/\/+$/, '');
  cfg.memoryService.scene = String(cfg.memoryService.scene || 'pet');
  if (!Number.isFinite(cfg.memoryService.recallK) || cfg.memoryService.recallK < 1 || cfg.memoryService.recallK > 10) {
    throw new Error('memoryService.recallK 必须是 1–10');
  }
  if (!Number.isFinite(cfg.memoryService.timeoutMs) || cfg.memoryService.timeoutMs < 100 || cfg.memoryService.timeoutMs > 5000) {
    throw new Error('memoryService.timeoutMs 必须是 100–5000 的毫秒数');
  }
  cfg.memoryService.ingest = cfg.memoryService.ingest !== false;
  if (!isObject(cfg.models) || Object.keys(cfg.models).length === 0) {
    throw new Error('models 至少要有一个 { 模型id: 宠物id } 映射');
  }
  for (const [model, petId] of Object.entries(cfg.models)) {
    if (typeof model !== 'string' || !model.trim()) throw new Error('models 的键必须是非空字符串');
    if (typeof petId !== 'string' || !petId.trim()) throw new Error(`models.${model} 必须是非空宠物 id`);
  }
  cfg.defaultModel = String(cfg.defaultModel || Object.keys(cfg.models)[0]);
  if (!Object.hasOwn(cfg.models, cfg.defaultModel)) {
    throw new Error(`defaultModel "${cfg.defaultModel}" 不在 models 里`);
  }
  if (!isObject(cfg.lifecycle)) cfg.lifecycle = { ...DEFAULTS.lifecycle };
  if (typeof cfg.lifecycle.orphanGuard !== 'boolean') cfg.lifecycle.orphanGuard = DEFAULTS.lifecycle.orphanGuard;
  if (
    !Number.isFinite(cfg.lifecycle.probeMs) ||
    cfg.lifecycle.probeMs < 5_000 ||
    cfg.lifecycle.probeMs > 600_000
  ) {
    throw new Error('lifecycle.probeMs 必须是 5000–600000 的毫秒数');
  }
  if (!Number.isInteger(cfg.lifecycle.maxMisses) || cfg.lifecycle.maxMisses < 1 || cfg.lifecycle.maxMisses > 60) {
    throw new Error('lifecycle.maxMisses 必须是 1–60 的整数');
  }
  if (!isObject(cfg.degradedReply)) cfg.degradedReply = { ...DEFAULTS.degradedReply };
  if (typeof cfg.degradedReply.enabled !== 'boolean') cfg.degradedReply.enabled = DEFAULTS.degradedReply.enabled;
  cfg.degradedReply.text = typeof cfg.degradedReply.text === 'string' ? cfg.degradedReply.text.trim() : '';
  if (cfg.degradedReply.text.length > 500) {
    throw new Error('degradedReply.text 最多 500 字');
  }
  if (!isObject(cfg.log)) cfg.log = { ...DEFAULTS.log };
  cfg.log.level = ['debug', 'info', 'warn', 'error'].includes(cfg.log.level) ? cfg.log.level : 'info';
  cfg.log.file = path.resolve(cfg.log.file || path.join(PACKAGE_ROOT, 'logs', 'pet-llm.log'));
  return cfg;
}

/**
 * @param {{configPath?: string, env?: NodeJS.ProcessEnv, logger?: {warn:Function}}} [options]
 * @returns {{config: object, token: string, configPath: string, tokenFile: string, stateDir: string}}
 */
export function loadConfig(options = {}) {
  const env = options.env ?? process.env;
  const configPath = path.resolve(options.configPath ?? env.PET_LLM_CONFIG ?? path.join(PACKAGE_ROOT, 'config.json'));
  const raw = readJson(configPath) ?? {};
  const cfg = normalizeConfig(raw, options.logger);
  const stateDir = path.resolve(env.PET_LLM_STATE_DIR ?? path.join(PACKAGE_ROOT, 'state'));
  ensureDir(stateDir);
  ensureDir(path.dirname(cfg.log.file));
  cfg.memoryService.tokenFile = path.resolve(
    env.PET_LLM_MEMORY_TOKEN_FILE ?? cfg.memoryService.tokenFile ?? path.join(stateDir, 'memory.token'),
  );
  const token = env.PET_LLM_TOKEN?.trim() || readOrCreateToken(stateDir, options.logger);
  return { config: cfg, token, configPath, tokenFile: path.join(stateDir, 'token.txt'), stateDir };
}
