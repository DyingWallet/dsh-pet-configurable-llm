// 手动 mock：验证 pet CLI 的路径/方法/请求体（不是单元测试）。
import http from 'node:http';

let counter = 1;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  let body = '';
  for await (const chunk of req) body += chunk;
  console.log(JSON.stringify({ method: req.method, path: url.pathname, query: url.search, body: body ? JSON.parse(body) : null }));
  const json = (value) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  if (url.pathname.endsWith('/state')) {
    return json({ counter: counter++, sections: {}, pets: { main: { say: { data: { text: '你好' } } } } });
  }
  if (url.pathname.endsWith('/lock')) {
    const parsed = body ? JSON.parse(body) : {};
    return json(parsed.lockId ? { ok: true } : { ok: true, lockId: 'L1', expiresAt: Date.now() + 60000 });
  }
  if (url.pathname.endsWith('/lock/release')) return json({ ok: true });
  if (url.pathname.endsWith('/broadcast')) return json({ ok: true });
  if (url.pathname.endsWith('/anim')) return json({ ok: true, playbackId: 'p1' });
  if (url.pathname.endsWith('/work-status')) return json({ state: 'thinking', task: '测试' });
  if (url.pathname.endsWith('/chat')) return json({ ok: true, text: '我在。' });
  if (url.pathname.endsWith('/position')) return json({ ok: true, x: 0.5, y: 0.5 });
  if (url.pathname.endsWith('/throw')) return json({ ok: true });
  if (url.pathname.endsWith('/models')) return json({ providers: [{ id: 'pet-llm', models: [{ id: 'xi' }] }] });
  res.writeHead(404);
  res.end('not found');
});
server.listen(Number(process.env.MOCK_PORT ?? 8791), '127.0.0.1', () => {
  console.log('mock pet listening', server.address().port);
});
