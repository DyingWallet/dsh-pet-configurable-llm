// 手动探针：验证 SSE 流（需要 pet-brain 已在 127.0.0.1:8790 运行）。
// 用法：node test/manual-stream.mjs "说一句话"
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const token = fs.readFileSync(path.join(here, '..', 'state', 'token.txt'), 'utf8').trim();
const text = process.argv[2] ?? '用一句话打个招呼。';

const response = await fetch('http://127.0.0.1:8790/v1/chat/completions', {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    model: 'xi',
    stream: true,
    messages: [{ role: 'user', content: text }],
  }),
});
console.log('status', response.status, response.headers.get('content-type'));
if (!response.ok) {
  console.log(await response.text());
  process.exit(1);
}
const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = '';
let out = '';
for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  let index;
  while ((index = buffer.indexOf('\n\n')) >= 0) {
    const frame = buffer.slice(0, index);
    buffer = buffer.slice(index + 2);
    for (const line of frame.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') {
        console.log('\n[DONE]');
        console.log('assembled:', out);
        process.exit(0);
      }
      try {
        const event = JSON.parse(data);
        if (event.error) console.log('\nERROR', event.error);
        const delta = event.choices?.[0]?.delta?.content;
        if (delta) {
          out += delta;
          process.stdout.write(delta);
        }
      } catch {
        // ignore comments/pings
      }
    }
  }
}
