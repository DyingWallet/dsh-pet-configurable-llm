import test from 'node:test';
import assert from 'node:assert/strict';
import { createPetLlmServer } from '../src/server.mjs';

function fakeAgent() {
  const bootstrapped = new Set();
  const calls = [];
  return {
    calls,
    bootstrapped,
    sessions: new Map([['main', 'session-test']]),
    meta: new Map([['main', { bootstrapped: false }]]),
    isBootstrapped: (petId) => bootstrapped.has(petId),
    markBootstrapped: (petId) => bootstrapped.add(petId),
    prompt: async (petId, text, options = {}) => {
      calls.push({ petId, text });
      if (options.onDelta) options.onDelta('你好');
      if (text.includes('__FAIL__')) return { ok: false, text: '', reason: 'timeout' };
      return { ok: true, text: '你好，我在。', reason: 'completed' };
    },
    health: async () => ({ reachable: true, baseUrl: 'http://127.0.0.1:1', presets: ['pet-chat'], sessions: { main: 'session-test' } }),
    resetSession: async () => undefined,
  };
}

function fakeMemory() {
  let card = { text: 'MEMORY-CARD-70903', chars: 17, generatedAt: '2026-10-23T00:00:00Z', files: [] };
  return {
    getCard: () => card,
    refresh: () => {
      card = { text: 'MEMORY-CARD-REFRESHED', chars: 24, generatedAt: '2026-10-23T01:00:00Z', files: [] };
      return card;
    },
  };
}

function fakeMemoryService() {
  const ingested = [];
  return {
    ingested,
    recallBlock: async () => 'RECALL-BLOCK-爵士乐',
    ingest: async (messages, petId) => {
      ingested.push({ petId, messages });
      return true;
    },
  };
}

// Undici（Node 内置 fetch）会拒绝一批“危险端口”；listen(0) 偶尔会撞上，重试即可。
const BAD_PORTS = new Set([0, 6000, 6665, 6666, 6667, 6668, 6669, 10080]);

function makeServer(configPatch = {}) {
  const agent = fakeAgent();
  const memory = fakeMemory();
  const memoryService = fakeMemoryService();
  const config = {
    dsh: { agentPreset: 'pet-chat', workspacePath: 'D:/deepseek_workspace' },
    memory: { cardFile: 'D:/deepseek_workspace/memories/.meta/card.md', injectCard: true },
    models: { xi: 'main' },
    defaultModel: 'xi',
    degradedReply: { enabled: true, text: '（降级：模型连不上）' },
    ...configPatch,
  };
  const server = createPetLlmServer({
    config,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    agent,
    memory,
    memoryService,
    token: 'test-token',
  });
  return { server, agent, memory, memoryService, config };
}

async function startServer(configPatch = {}) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const entry = makeServer(configPatch);
    await new Promise((resolve, reject) => {
      entry.server.once('error', reject);
      entry.server.listen(0, '127.0.0.1', resolve);
    });
    const port = entry.server.address().port;
    if (!BAD_PORTS.has(port)) return { ...entry, base: `http://127.0.0.1:${port}` };
    await new Promise((resolve) => entry.server.close(resolve));
  }
  throw new Error('无法分配到测试端口');
}

async function stop(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

test('health 不需要鉴权；models 需要', async () => {
  const { server, base } = await startServer();
  try {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    const body = await health.json();
    assert.equal(body.ok, true);
    assert.equal(body.memory.chars, 17);

    const unauthorized = await fetch(`${base}/v1/models`);
    assert.equal(unauthorized.status, 401);

    const models = await fetch(`${base}/v1/models`, { headers: { authorization: 'Bearer test-token' } });
    assert.equal(models.status, 200);
    const list = await models.json();
    assert.deepEqual(list.data.map((item) => item.id), ['xi']);
  } finally {
    await stop(server);
  }
});

test('非流式对话：第一轮注入记忆卡，第二轮不再注入', async () => {
  const { server, agent, base } = await startServer();
  try {
    const request = () =>
      fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'xi', stream: false, messages: [{ role: 'user', content: '在吗' }] }),
      });

    const first = await request();
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.equal(firstBody.choices[0].message.content, '你好，我在。');
    assert.match(agent.calls[0].text, /MEMORY-CARD-70903/);
    assert.equal(agent.bootstrapped.has('main'), true);

    const second = await request();
    assert.equal(second.status, 200);
    assert.doesNotMatch(agent.calls[1].text, /MEMORY-CARD-70903/);
  } finally {
    await stop(server);
  }
});

test('流式对话返回 SSE delta 与 [DONE]', async () => {
  const { server, base } = await startServer();
  try {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'xi', stream: true, messages: [{ role: 'user', content: '说句话' }] }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /event-stream/);
    const text = await response.text();
    assert.match(text, /"content":"你好"/);
    assert.match(text, /"finish_reason":"stop"/);
    assert.match(text, /data: \[DONE\]/);
  } finally {
    await stop(server);
  }
});

test('未知模型返回 404；生成失败默认降级成 200 + 说明文案', async () => {
  const { server, memoryService, base } = await startServer();
  try {
    const unknown = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'nope', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(unknown.status, 404);

    // 流式：失败也按正常 SSE 收尾，dsh-pet 才会认为是「成功生成」而不去回落普通模型
    const failed = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'xi',
        stream: true,
        messages: [{ role: 'user', content: '__FAIL__ 失败测试' }],
      }),
    });
    assert.equal(failed.status, 200);
    const text = await failed.text();
    assert.match(text, /（降级：模型连不上）/);
    assert.match(text, /"finish_reason":"stop"/);
    assert.match(text, /data: \[DONE\]/);
    assert.doesNotMatch(text, /"error"/);

    // 非流式同样降级
    const plain = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'xi', stream: false, messages: [{ role: 'user', content: '__FAIL__ 再来' }] }),
    });
    assert.equal(plain.status, 200);
    const plainBody = await plain.json();
    assert.equal(plainBody.choices[0].message.content, '（降级：模型连不上）');
    assert.equal(plainBody.pet_llm.degraded, true);
    assert.equal(plainBody.pet_llm.reason, 'timeout');

    // 降级文案不写进长期记忆（否则会被当成桌宠真说过的话）
    await new Promise((resolve) => setTimeout(resolve, 10));
    const texts = memoryService.ingested.map((entry) => entry.messages[0]?.content ?? '');
    assert.ok(!texts.some((t) => String(t).includes('（降级：模型连不上）')), 'degraded reply must not be ingested');
  } finally {
    await stop(server);
  }
});

test('关掉降级时仍然返回 SSE error 帧（便于排查）', async () => {
  const { server, base } = await startServer({ degradedReply: { enabled: false, text: '' } });
  try {
    const failed = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'xi',
        stream: true,
        messages: [{ role: 'user', content: '__FAIL__ 失败测试' }],
      }),
    });
    assert.equal(failed.status, 200);
    const text = await failed.text();
    assert.match(text, /"error"/);
    assert.match(text, /"code":"timeout"/);
  } finally {
    await stop(server);
  }
});

test('记忆服务：召回块进 prompt，用户与回复都入库', async () => {
  const { server, agent, memoryService, base } = await startServer();
  try {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'xi', stream: false, messages: [{ role: 'user', content: '放点爵士' }] }),
    });
    assert.equal(response.status, 200);
    assert.match(agent.calls[0].text, /RECALL-BLOCK-爵士乐/);
    assert.ok(
      agent.calls[0].text.indexOf('RECALL-BLOCK-爵士乐') < agent.calls[0].text.indexOf('MEMORY-CARD-70903'),
      'recall block goes before the bootstrap card',
    );

    await new Promise((resolve) => setTimeout(resolve, 10));
    const roles = memoryService.ingested.map((entry) => entry.messages[0]?.role ?? entry.messages?.role);
    const texts = memoryService.ingested.map((entry) => entry.messages[0]?.content ?? entry.messages?.text);
    assert.ok(texts.some((text) => String(text).includes('放点爵士')), 'user message ingested');
    assert.ok(texts.some((text) => String(text).includes('你好，我在。')), 'assistant reply ingested');
  } finally {
    await stop(server);
  }
});

test('记忆卡刷新接口', async () => {
  const { server, base } = await startServer();
  try {
    const response = await fetch(`${base}/admin/memory/refresh`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token' },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.chars, 24);
  } finally {
    await stop(server);
  }
});
