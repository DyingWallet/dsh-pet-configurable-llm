// 轻量日志：控制台 + 单文件追加（按大小轮转，保留一份 .1）。
// 日志里永远不写 token / cookie / 消息正文。
import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_BYTES = 10 * 1024 * 1024;

export function createLogger({ level = 'info', file = '' } = {}) {
  const min = LEVELS[level] ?? LEVELS.info;
  if (file) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
    } catch {
      file = '';
    }
  }

  function rotate() {
    if (!file) return;
    try {
      if (fs.statSync(file).size < MAX_BYTES) return;
      fs.renameSync(file, `${file}.1`);
    } catch {
      // 文件不存在或改名失败：继续写当前文件即可
    }
  }

  function write(level, message) {
    if ((LEVELS[level] ?? 99) < min) return;
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}`;
    // eslint-disable-next-line no-console
    (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
    if (!file) return;
    try {
      rotate();
      fs.appendFileSync(file, line + '\n');
    } catch {
      // 日志失败不影响主流程
    }
  }

  return {
    debug: (message) => write('debug', message),
    info: (message) => write('info', message),
    warn: (message) => write('warn', message),
    error: (message) => write('error', message),
    close: () => {},
  };
}
