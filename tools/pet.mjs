#!/usr/bin/env node
// pet 控制 CLI：把 dsh-pet 的第三方接口包成一条命令。
// 用法：
//   node tools/pet.mjs state
//   node tools/pet.mjs say "我回来了" --duration 10000
//   node tools/pet.mjs anim 女仆屈膝礼仪 --facing left
//   node tools/pet.mjs status thinking --task "读代码"
//   node tools/pet.mjs lock --ttl 60000 / unlock --lock-id ...
//   node tools/pet.mjs chat "在吗"
//   node tools/pet.mjs position 0.8 0.2 / throw 45 1.2
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDshBaseUrl } from '../../qq-bridge/src/lib/dsh-endpoint.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const API = '/dsh-pet-7340';
const WORK_STATES = ['thinking', 'working', 'result', 'waiting', 'success', 'error'];

function readConfig() {
  const file = process.env.PET_BRAIN_CONFIG || path.join(here, '..', 'config.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else {
        out[key] = next;
        index += 1;
      }
    } else out._.push(arg);
  }
  return out;
}

function usage() {
  console.log(`用法：node tools/pet.mjs <命令> [参数]

命令：
  state                         读 /state（--json 原样输出）
  say <文本>                    投喂气泡（自动取/放锁）；--duration 10000 --image 名称 --url 地址 --no-lock
  anim <动画名>                 点播动画；--facing left|right --url 地址
  bubble-clear                  收起气泡
  status <档位> [--task 文案]   写外部工作状态（thinking/working/result/waiting/success/error）
  idle                          清空外部工作状态
  lock [--ttl 60000]            取锁并打印 lockId
  unlock [--lock-id ID]         释放锁
  chat <文本>                   走桌宠自己的 /chat（会经过它配置的模型）
  position <x> <y>              挪位置（归一化 0–1，自动取/放锁）
  throw <angle> <power>         抛掷（角度/力度，自动取/放锁）
  models                        读桌宠可用模型

全局参数：--pet main --surface desktop|web --base http://127.0.0.1:12085 --json
`);
}

async function baseUrl(config, args) {
  if (args.base) return String(args.base).replace(/\/+$/, '');
  const configured = String(config?.dsh?.baseUrl ?? '').trim();
  const env = String(process.env.DSH_WEB_URL ?? '').trim();
  if (configured) return configured.replace(/\/+$/, '');
  if (env) return env.replace(/\/+$/, '');
  const resolved = await resolveDshBaseUrl('', { timeoutMs: 800, discover: true });
  if (!resolved.reachable) throw new Error(`DSH 不可达：${resolved.candidates.join(', ')}`);
  return resolved.url;
}

async function request(base, pathname, { method = 'GET', body, timeout = 20_000 } = {}) {
  const response = await fetch(base + pathname, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // 非 JSON（例如 405 的纯文本）
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${pathname}: ${parsed?.error ?? text.slice(0, 200)}`);
  }
  return parsed;
}

function query({ pet, surface }) {
  return `?pet=${encodeURIComponent(pet)}&surface=${encodeURIComponent(surface)}`;
}

function okOrThrow(result, action) {
  if (result && result.ok === true) return result;
  const reason = result?.reason ? `（${result.reason}）` : '';
  throw new Error(`${action}失败${reason}：${result?.message ?? JSON.stringify(result)}`);
}

async function acquireLock(base, pet, surface, ttl, wait) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await request(base, `${API}/lock${query({ pet, surface })}`, {
      method: 'POST',
      body: { ttl },
    });
    if (result?.ok === true) return result.lockId;
    if (result?.reason === 'locked' && wait && attempt === 0) {
      const waitMs = Math.max(0, Math.min(10_000, Number(result.expiresAt) - Date.now() + 250));
      console.log(`桌宠被占用，等 ${waitMs}ms…`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    }
    okOrThrow(result, '取锁');
  }
  throw new Error('取锁失败');
}

async function releaseLock(base, pet, surface, lockId) {
  if (!lockId) return;
  try {
    await request(base, `${API}/lock/release${query({ pet, surface })}`, {
      method: 'POST',
      body: { lockId },
    });
  } catch (error) {
    console.warn(`释放锁失败：${error?.message ?? error}`);
  }
}

async function withLock(base, pet, surface, ttl, wait, fn) {
  const lockId = await acquireLock(base, pet, surface, ttl, wait);
  try {
    return await fn(lockId);
  } finally {
    await releaseLock(base, pet, surface, lockId);
  }
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0];
if (!command || command === 'help' || args.help) {
  usage();
  process.exit(command ? 0 : 1);
}

const config = readConfig();
const pet = String(args.pet ?? 'main');
const surface = String(args.surface ?? 'desktop');
const json = args.json === true;

try {
  const base = await baseUrl(config, args);
  const ttl = Number(args.ttl ?? 15_000);
  const wait = args.wait === true;

  if (command === 'state') {
    const state = await request(base, `${API}/state`);
    if (json) console.log(JSON.stringify(state, null, 2));
    else {
      console.log(`counter=${state?.counter}`);
      for (const [id, petState] of Object.entries(state?.pets ?? {})) {
        const say = petState?.say?.data;
        console.log(`- ${id}: ${say?.text ? `“${say.text}”` : '（无气泡）'}`);
      }
      const ws = state?.sections?.workStatus?.data;
      if (ws) console.log(`workStatus: ${ws.state ?? 'idle'} ${ws.task ?? ''}`);
    }
  } else if (command === 'models') {
    const models = await request(base, `${API}/models`);
    console.log(JSON.stringify(models, null, 2));
  } else if (command === 'say') {
    const text = args._.slice(1).join(' ').trim();
    if (!text) throw new Error('say 需要文本');
    const body = { text, duration: Number(args.duration ?? 10_000) };
    if (args.image) body.image = String(args.image);
    if (args.url) body.url = String(args.url);
    if (args['no-lock']) {
      const result = await request(base, `${API}/broadcast${query({ pet, surface })}`, { method: 'POST', body });
      okOrThrow(result, '投喂');
      console.log(`已投喂：${text}`);
    } else {
      await withLock(base, pet, surface, ttl, wait, async (lockId) => {
        const result = await request(
          base,
          `${API}/broadcast${query({ pet, surface })}&lock=${encodeURIComponent(lockId)}`,
          { method: 'POST', body },
        );
        okOrThrow(result, '投喂');
      });
      console.log(`已投喂：${text}`);
    }
  } else if (command === 'anim') {
    const name = args._.slice(1).join(' ').trim();
    const body = {};
    if (name) body.name = name;
    if (args.url) body.url = String(args.url);
    if (!body.name && !body.url) throw new Error('anim 需要动画名或 --url');
    if (args.facing) body.facing = String(args.facing);
    await withLock(base, pet, surface, ttl, wait, async (lockId) => {
      const result = await request(base, `${API}/anim${query({ pet, surface })}&lock=${encodeURIComponent(lockId)}`, {
        method: 'POST',
        body,
      });
      okOrThrow(result, '点播');
      console.log(`已点播：${body.name ?? body.url}（playbackId=${result.playbackId ?? '-'}）`);
    });
  } else if (command === 'bubble-clear') {
    await withLock(base, pet, surface, ttl, wait, async (lockId) => {
      const result = await request(
        base,
        `${API}/bubble/clear${query({ pet, surface })}&lock=${encodeURIComponent(lockId)}`,
        { method: 'POST', body: {} },
      );
      okOrThrow(result, '清空气泡');
      console.log('气泡已清空');
    });
  } else if (command === 'status') {
    const state = String(args._[1] ?? '');
    if (!WORK_STATES.includes(state)) throw new Error(`档位必须是 ${WORK_STATES.join(' / ')}`);
    const body = { state };
    if (args.task !== undefined) body.task = String(args.task);
    const result = await request(base, `${API}/work-status`, { method: 'POST', body });
    console.log(`状态：${result?.state ?? state}${result?.task ? ` / ${result.task}` : ''}`);
  } else if (command === 'idle') {
    await request(base, `${API}/work-status`, { method: 'DELETE' });
    console.log('外部工作状态已清空');
  } else if (command === 'lock') {
    const lockId = await acquireLock(base, pet, surface, ttl, wait);
    console.log(lockId);
  } else if (command === 'unlock') {
    const lockId = args['lock-id'] ? String(args['lock-id']) : '';
    if (!lockId) throw new Error('unlock 需要 --lock-id（或先执行 lock 保存返回值）');
    await releaseLock(base, pet, surface, lockId);
    console.log('已释放');
  } else if (command === 'chat') {
    const text = args._.slice(1).join(' ').trim();
    if (!text) throw new Error('chat 需要文本');
    const result = await request(base, `${API}/chat${query({ pet, surface })}`, {
      method: 'POST',
      body: { text },
      timeout: 90_000,
    });
    okOrThrow(result, '对话');
    console.log(result.text);
  } else if (command === 'position') {
    const x = Number(args._[1]);
    const y = Number(args._[2]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('position 需要 x y（0–1）');
    const body = { x, y, mode: String(args.mode ?? 'spring') };
    await withLock(base, pet, surface, ttl, wait, async (lockId) => {
      const result = await request(
        base,
        `${API}/position${query({ pet, surface })}&lock=${encodeURIComponent(lockId)}`,
        { method: 'POST', body },
      );
      okOrThrow(result, '移动');
      console.log(`位置：${result.x}, ${result.y}`);
    });
  } else if (command === 'throw') {
    const angle = Number(args._[1]);
    const power = Number(args._[2]);
    if (!Number.isFinite(angle) || !Number.isFinite(power)) throw new Error('throw 需要 angle power');
    await withLock(base, pet, surface, ttl, wait, async (lockId) => {
      const result = await request(
        base,
        `${API}/throw${query({ pet, surface })}&lock=${encodeURIComponent(lockId)}`,
        { method: 'POST', body: { angle, power } },
      );
      okOrThrow(result, '抛掷');
      console.log('已抛掷');
    });
  } else {
    throw new Error(`未知命令：${command}`);
  }
} catch (error) {
  console.error(`pet: ${error?.message ?? error}`);
  process.exitCode = 1;
}
