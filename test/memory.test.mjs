// memd 客户端：召回块的拼装顺序（「刚刚在聊的」在前，长期记忆在后）。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryService } from '../src/memory.mjs';

async function startMemd(handler) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const payload = body ? JSON.parse(body) : null;
    seen.push({ url: req.url, payload });
    const value = handler(req, payload);
    if (value === undefined) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { seen, server, base: `http://127.0.0.1:${server.address().port}` };
}

function tokenFileInTempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'pet-mem-'));
  const tokenFile = join(dir, 'token');
  writeFileSync(tokenFile, 'tk', 'utf8');
  return tokenFile;
}

test('recallBlock 取服务端渲染好的 block，并带上 format 与预算', async () => {
  const { seen, server, base } = await startMemd(() => ({
    keywords: [],
    results: [],
    live: [],
    block: '【最近在聊的】\n- 14:45 我们在聊人是不是被经历塑造的\n\n【长期记忆】\n- 长期记忆里的爵士乐',
  }));
  try {
    const service = createMemoryService(
      { memoryService: { endpoint: base, tokenFile: tokenFileInTempDir(), scene: 'pet' } },
      null,
    );
    const block = await service.recallBlock([{ role: 'user', content: '在吗' }]);
    assert.match(block, /最近在聊的/);
    assert.match(block, /长期记忆里的爵士乐/);
    assert.equal(seen[0].payload.format, 'block');
    assert.equal(seen[0].payload.max_chars, 1500);
    assert.deepEqual(seen[0].payload.live, { k: 6, minutes: 30, scenes: ['main'] });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('没有 live 时服务端只给长期记忆块', async () => {
  const { server, base } = await startMemd(() => ({
    keywords: ['爵士'],
    results: [],
    live: [],
    block: '【长期记忆】\n- 长期记忆里的爵士乐',
  }));
  try {
    const service = createMemoryService(
      { memoryService: { endpoint: base, tokenFile: tokenFileInTempDir(), scene: 'pet' } },
      null,
    );
    const block = await service.recallBlock([{ role: 'user', content: '放点爵士' }]);
    assert.equal(block.includes('最近在聊的'), false);
    assert.match(block, /长期记忆里的爵士乐/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('live:false 时不再向 memd 请求 live', async () => {
  const { seen, server, base } = await startMemd(() => ({ keywords: [], results: [] }));
  try {
    const service = createMemoryService(
      { memoryService: { endpoint: base, tokenFile: tokenFileInTempDir(), scene: 'pet', live: false } },
      null,
    );
    await service.recallBlock([{ role: 'user', content: '在吗' }]);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].payload.live, undefined);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('memd 出错时返回空块，不抛错', async () => {
  const { server, base } = await startMemd(() => undefined);
  try {
    const service = createMemoryService(
      { memoryService: { endpoint: base, tokenFile: tokenFileInTempDir(), scene: 'pet' } },
      null,
    );
    assert.equal(await service.recallBlock([{ role: 'user', content: '在吗' }]), '');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
