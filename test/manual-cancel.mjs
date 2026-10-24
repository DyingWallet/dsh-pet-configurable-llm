// 手动探针：验证客户端断开 -> 模型调用取消 -> 后续请求仍可用。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const token = fs.readFileSync(path.join(here, '..', 'state', 'token.txt'), 'utf8').trim();
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

async function chat(prompt, { abortAfterMs = 0 } = {}) {
  const controller = new AbortController();
  const response = await fetch('http://127.0.0.1:8790/v1/chat/completions', {
    method: 'POST',
    headers,
    signal: controller.signal,
    body: JSON.stringify({ model: 'xi', stream: true, messages: [{ role: 'user', content: prompt }] }),
  });
  let timer;
  if (abortAfterMs > 0) timer = setTimeout(() => controller.abort(), abortAfterMs);
  let text = '';
  try {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    return { ok: true, text };
  } catch (error) {
    return { ok: false, error: String(error?.name ?? error), text };
  } finally {
    clearTimeout(timer);
  }
}

const first = await chat('读 memories/index.md 和最近两篇日志，用五句话总结，慢慢说。', { abortAfterMs: 700 });
console.log('first:', first.ok, first.error ?? '', 'bytes=', first.text.length);
await new Promise((resolve) => setTimeout(resolve, 2000));
const second = await chat('用一句话说：你还在吗？');
console.log('second:', second.ok, second.text.includes('[DONE]') ? 'done' : 'no-done');
console.log(second.text.slice(-300));
