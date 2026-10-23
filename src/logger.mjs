// 轻量日志：控制台 + 单文件追加。日志里永远不写 token / cookie / 消息正文。
import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger({ level = 'info', file = '' } = {}) {
  const min = LEVELS[level] ?? LEVELS.info;
  let stream = null;
  if (file) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      stream = fs.createWriteStream(file, { flags: 'a' });
    } catch {
      stream = null;
    }
  }
  function write(level, message) {
    if ((LEVELS[level] ?? 99) < min) return;
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}`;
    // eslint-disable-next-line no-console
    (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
    try {
      stream?.write(line + '\n');
    } catch {
      // 日志失败不影响主流程
    }
  }
  return {
    debug: (message) => write('debug', message),
    info: (message) => write('info', message),
    warn: (message) => write('warn', message),
    error: (message) => write('error', message),
    close: () => {
      try {
        stream?.end();
      } catch {
        // ignore
      }
    },
  };
}
