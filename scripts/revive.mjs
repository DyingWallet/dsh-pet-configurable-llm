// scripts/revive.mjs —— 1 分钟看护：DSH 在、pet-brain 不在，就把它拉起来。
//
// 为什么需要：pet-brain 的长命由 DSH 决定（src/guard.mjs 在 DSH 连续 3x20 秒不可达时自退），
// 所以 DSH 重启超过 ~60 秒时 pet 会被判定为孤儿并退出；DSH 回来之后没有任何东西会再拉起它，
// 8790 就空着——而 DSH 的 pet-chat 请求连不上 8790 时，dsh-pet 会回落到普通对话模型
// （degraded.mjs 里挡不住这一种，因为请求根本没到我们这层）。
//
// 这个脚本只做三件事：
//   1. 8790 已经在听 -> 什么都不做（绝大多数情况）；
//   2. DSH 不可达 -> 也不做（此时不该有 pet，起来了也会被 guard 杀掉）；
//   3. 其余情况 -> detached 起 src/index.mjs，把 DSH_WEB_URL 传下去。
//
// 由计划任务 pet-revive 每分钟跑一次，普通运行只写一行日志（logs/revive.log）。
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, openSync, renameSync, statSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDshBaseUrl } from '../../qq-bridge/src/lib/dsh-endpoint.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG_DIR = path.join(ROOT, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'revive.log');
const PORT = 8790;
const LOG_MAX_BYTES = 200 * 1024;

function log(message) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > LOG_MAX_BYTES) {
      renameSync(LOG_FILE, `${LOG_FILE}.1`);
    }
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${message}\n`, 'utf8');
  } catch {
    // 日志失败不影响看护
  }
}

function portOpen(port, timeoutMs = 700) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

async function main() {
  if (await portOpen(PORT)) {
    // 正常情况：每分钟一次静默退出，不写日志（避免 1440 行/天的噪声）。
    process.exit(0);
  }

  const configured = String(process.env.DSH_WEB_URL ?? '').trim();
  let dshUrl = '';
  try {
    const resolved = await resolveDshBaseUrl(configured, { timeoutMs: 800, discover: true });
    if (resolved.reachable) dshUrl = resolved.url;
  } catch {
    // 当作 DSH 不可达
  }
  if (!dshUrl) {
    log(`port ${PORT} closed, DSH unreachable -> skipped (no pet without DSH)`);
    process.exit(0);
  }

  const entry = path.join(ROOT, 'src', 'index.mjs');
  if (!existsSync(entry)) {
    log(`missing entry ${entry}`);
    process.exit(1);
  }

  mkdirSync(LOG_DIR, { recursive: true });
  const out = openSync(path.join(LOG_DIR, 'pet.out.log'), 'a');
  const err = openSync(path.join(LOG_DIR, 'pet.err.log'), 'a');
  const child = spawn(process.execPath, [entry], {
    cwd: ROOT,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', out, err],
    env: { ...process.env, DSH_WEB_URL: dshUrl },
  });
  child.unref();
  log(`port ${PORT} closed, DSH ${dshUrl} reachable -> started pet pid=${child.pid}`);
  process.exit(0);
}

main().catch((error) => {
  log(`ERROR ${error?.stack ?? error}`);
  process.exit(1);
});
