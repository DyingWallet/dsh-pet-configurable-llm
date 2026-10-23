// OpenAI 兼容层：POST /v1/chat/completions + GET /v1/models。
//
// 只做三件事：
//   1. 鉴权（Bearer token，仅回环地址）；
//   2. 取最后一条 user 文本（忽略 tools / 历史 —— 桌宠自己的 memory 不参与）；
//   3. 调 DshBrain（专用 DSH 会话），把回复按 SSE 吐回去。
import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';

const BODY_LIMIT = 2 * 1024 * 1024;
const SSE_PING_MS = 15_000;

function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function openaiError(res, status, message, { type = 'invalid_request_error', code = null } = {}) {
  sendJson(res, status, { error: { message, type, param: null, code } });
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function authorized(req, token) {
  const header = req.headers.authorization;
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    if (safeEqual(header.slice(7).trim(), token)) return true;
  }
  const key = req.headers['x-api-key'];
  return typeof key === 'string' && safeEqual(key.trim(), token);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(Object.assign(new Error('请求体过大'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function lastUserText(messages) {
  if (!Array.isArray(messages)) return '';
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== 'user') continue;
    const content = message.content;
    if (typeof content === 'string') return content.trim();
    if (Array.isArray(content)) {
      return content
        .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('')
        .trim();
    }
  }
  return '';
}

function nowLine() {
  const now = new Date();
  return `【现在 ${now.toLocaleString('zh-CN', {
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })}】`;
}

function bootstrapText(card, userText, name = '桌宠') {
  return (
    `【${name}的长期记忆 · 启动卡】\n` +
    `你是${name}。下面是你的长期记忆摘录，来源是 memories/；需要细节时用只读工具读 memories/index.md 或对应文件。\n` +
    '回复保持 1–3 句、口语、不用 Markdown；不要把【现在…】或【桌宠形态】写进回复；不要主动输出凭据、QQ 号或本机路径。\n\n' +
    (card?.text ?? '（记忆卡为空）') +
    '\n\n' +
    nowLine() +
    '\n【桌宠形态】你的回答会直接显示在桌面气泡里，10 秒后消失。\n' +
    '\n【本轮用户说】\n' +
    userText
  );
}

function writeSse(res, payload) {
  if (res.destroyed || res.writableEnded) return false;
  try {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

function completionChunk({ id, created, model, delta, finish = null }) {
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

/**
 * @param {object} options
 * @param {object} options.config
 * @param {object} options.logger
 * @param {object} options.brain
 * @param {{getCard: Function, refresh: Function}} options.memory
 * @param {{recallBlock: Function, ingest: Function}} [options.memoryService]
 * @param {string} options.token
 */
export function createPetBrainServer({ config, logger, brain, memory, memoryService, token }) {
  const models = Object.keys(config.models);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = req.method ?? 'GET';
    const startedAt = Date.now();

    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'authorization, content-type, x-api-key');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      if (url.pathname === '/health' && method === 'GET') {
        const dsh = await brain.health();
        sendJson(res, 200, {
          ok: dsh.reachable === true,
          service: 'pet-brain',
          dsh,
          memory: {
            cardFile: config.memory.cardFile,
            chars: memory.getCard()?.chars ?? 0,
            generatedAt: memory.getCard()?.generatedAt ?? null,
          },
          models,
          preset: config.dsh.agentPreset,
          workspacePath: config.dsh.workspacePath,
        });
        return;
      }

      if (!authorized(req, token)) {
        openaiError(res, 401, '缺少或错误的本地访问令牌', { type: 'authentication_error', code: 'invalid_api_key' });
        return;
      }

      if (url.pathname === '/v1/models' && method === 'GET') {
        sendJson(res, 200, {
          object: 'list',
          data: models.map((id) => ({
            id,
            object: 'model',
            created: 0,
            owned_by: 'pet-brain',
          })),
        });
        return;
      }

      if (
        (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions') &&
        method === 'POST'
      ) {
        let body;
        try {
          body = JSON.parse((await readBody(req)) || 'null');
        } catch (error) {
          openaiError(res, error?.status === 413 ? 413 : 400, '请求体不是合法 JSON');
          return;
        }
        if (!body || typeof body !== 'object') {
          openaiError(res, 400, '请求体必须是 JSON 对象');
          return;
        }
        const model = typeof body.model === 'string' ? body.model : '';
        const petId = config.models[model];
        if (!petId) {
          openaiError(res, 404, `未知模型：${model || '(空)'}`, { code: 'model_not_found' });
          return;
        }
        const userText = lastUserText(body.messages);
        if (!userText) {
          openaiError(res, 400, 'messages 里没有可用的 user 文本');
          return;
        }
        if (userText.length > 32_000) {
          openaiError(res, 400, 'user 文本超过 32000 字');
          return;
        }

        const stream = body.stream === true;
        const id = `chatcmpl-${randomUUID()}`;
        const created = Math.floor(Date.now() / 1000);
        const bootstrap = config.memory.injectCard === true && !brain.isBootstrapped(petId);

        // memd：先召回（失败只当没有记忆），再把本轮用户消息写进短期层。
        const recall = memoryService ? await memoryService.recallBlock(body.messages).catch(() => '') : '';
        if (memoryService) void memoryService.ingest(body.messages, petId).catch(() => {});

        const basePrompt = bootstrap ? bootstrapText(memory.getCard(), userText, config.identity?.name ?? '桌宠') : userText;
        const promptText = recall ? `${recall}\n\n${basePrompt}` : basePrompt;
        const abort = new AbortController();
        let finished = false;
        res.on('close', () => {
          if (!finished) abort.abort();
        });

        logger.info(
          `chat model=${model} pet=${petId} stream=${stream} bootstrap=${bootstrap} chars=${userText.length}`,
        );

        if (!stream) {
          const result = await brain.prompt(petId, promptText, { signal: abort.signal });
          finished = true;
          if (!result.ok) {
            openaiError(res, 502, result.message ?? `DSH 生成失败（${result.reason}）`, {
              type: 'server_error',
              code: result.reason ?? 'brain_error',
            });
            logger.warn(`chat 失败 pet=${petId} reason=${result.reason} ${result.message ?? ''}`);
            return;
          }
          if (bootstrap) brain.markBootstrapped(petId);
          const text = result.text.trim();
          if (memoryService) void memoryService.ingest([{ role: 'assistant', content: text }], petId).catch(() => {});
          sendJson(res, 200, {
            id,
            object: 'chat.completion',
            created,
            model,
            choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 0, completion_tokens: text.length, total_tokens: text.length },
          });
          logger.info(`chat 完成 pet=${petId} ms=${Date.now() - startedAt} chars=${text.length}`);
          return;
        }

        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        res.flushHeaders?.();
        writeSse(res, completionChunk({ id, created, model, delta: { role: 'assistant', content: '' } }));
        const ping = setInterval(() => {
          if (res.destroyed || res.writableEnded) return;
          try {
            res.write(': ping\n\n');
          } catch {
            // ignore
          }
        }, SSE_PING_MS);

        const result = await brain.prompt(petId, promptText, {
          signal: abort.signal,
          onDelta: (text) => {
            writeSse(res, completionChunk({ id, created, model, delta: { content: text } }));
          },
        });
        finished = true;
        clearInterval(ping);
        if (!result.ok) {
          writeSse(res, {
            error: {
              message: result.message ?? `DSH 生成失败（${result.reason}）`,
              type: 'server_error',
              code: result.reason ?? 'brain_error',
            },
          });
          res.write('data: [DONE]\n\n');
          res.end();
          logger.warn(`chat 失败 pet=${petId} reason=${result.reason} ${result.message ?? ''}`);
          return;
        }
        if (bootstrap) brain.markBootstrapped(petId);
        if (memoryService) void memoryService.ingest([{ role: 'assistant', content: result.text.trim() }], petId).catch(() => {});
        writeSse(res, completionChunk({ id, created, model, delta: {}, finish: 'stop' }));
        res.write('data: [DONE]\n\n');
        res.end();
        logger.info(`chat 完成 pet=${petId} ms=${Date.now() - startedAt} chars=${result.text.trim().length}`);
        return;
      }

      if (url.pathname === '/admin/memory/refresh' && method === 'POST') {
        const card = memory.refresh();
        sendJson(res, 200, { ok: true, chars: card.chars, generatedAt: card.generatedAt, files: card.files });
        return;
      }

      if (url.pathname === '/admin/sessions' && method === 'GET') {
        sendJson(res, 200, {
          ok: true,
          sessions: Object.fromEntries(brain.sessions),
          meta: Object.fromEntries(brain.meta),
        });
        return;
      }

      if (url.pathname === '/admin/sessions/reset' && method === 'POST') {
        let body;
        try {
          body = JSON.parse((await readBody(req)) || 'null');
        } catch {
          openaiError(res, 400, '请求体不是合法 JSON');
          return;
        }
        const petId = typeof body?.petId === 'string' ? body.petId : '';
        if (!petId) {
          openaiError(res, 400, 'petId 必填');
          return;
        }
        await brain.resetSession(petId);
        sendJson(res, 200, { ok: true, petId });
        return;
      }

      openaiError(res, 404, `未知路径：${url.pathname}`, { code: 'not_found' });
    } catch (error) {
      logger.error(`请求处理失败 ${method} ${url.pathname}: ${error?.stack ?? error}`);
      if (!res.headersSent) openaiError(res, 500, 'pet-brain 内部错误', { type: 'server_error' });
      else if (!res.writableEnded) res.end();
    }
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 65_000;
  return server;
}
