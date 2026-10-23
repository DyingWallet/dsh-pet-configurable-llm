// memd 客户端：把桌宠会话接进 memory-service。
//
// - recall：每轮把最近消息发给 /v1/recall（scene=pet），返回一段可拼进 prompt 的记忆块；
// - ingest：把桌宠的对话写进短期记忆（不限条数，按 50 条/请求分批）。
//
// 约定：memd 不在线时静默降级（返回空块 / false），绝不阻塞桌宠回复。
import fs from 'node:fs';
import { createHash } from 'node:crypto';

const INGEST_BATCH = 50;

function messageText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n');
  }
  return '';
}

export function createMemoryService(config, logger) {
  const cfg = config.memoryService ?? {};
  const endpoint = String(cfg.endpoint ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
  const scene = String(cfg.scene ?? 'pet');
  const timeoutMs = Number(cfg.timeoutMs) || 800;
  const recallK = Number(cfg.recallK) || 3;
  const maxChars = Number(cfg.recallMaxChars) || 800;

  function readToken() {
    try {
      return fs.readFileSync(cfg.tokenFile, 'utf8').trim();
    } catch {
      return '';
    }
  }

  async function call(path, body) {
    const token = readToken();
    if (!token) throw new Error('记忆令牌缺失');
    const response = await fetch(`${endpoint}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`memd ${response.status}`);
    return response.json();
  }

  async function recallBlock(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return '';
    try {
      const usable = messages
        .map((message) => ({ role: message?.role === 'assistant' ? 'assistant' : 'user', text: messageText(message).trim() }))
        .filter((message) => message.text.length > 0)
        .slice(-6);
      if (usable.length === 0) return '';
      const data = await call('/v1/recall', { messages: usable, k: recallK, scene });
      const results = Array.isArray(data?.results) ? data.results : [];
      if (results.length === 0) return '';
      const perLine = Math.max(120, Math.floor(maxChars / results.length));
      const lines = ['【长期记忆】（只是背景，不要原样复述）'];
      for (const result of results) {
        const text = String(result?.render?.text ?? result?.title ?? '').trim();
        if (!text) continue;
        const marker = result?.disclosure === 'owner_initiated' ? '（对方自己提起过的）' : '';
        lines.push(`- ${marker}${text.slice(0, perLine)}`);
      }
      return lines.length > 1 ? lines.join('\n') : '';
    } catch (error) {
      logger?.debug?.(`记忆召回失败：${error?.message ?? error}`);
      return '';
    }
  }

  async function ingest(messages, petId = 'main') {
    if (cfg.ingest === false) return false;
    const usable = (Array.isArray(messages) ? messages : [])
      .map((message) => ({
        role: message?.role === 'assistant' ? 'assistant' : 'user',
        text: messageText(message).trim(),
      }))
      .filter((message) => message.text.length > 0);
    if (usable.length === 0) return false;

    const stamp = Date.now().toString(36);
    const payload = usable.map((message, index) => ({
      message_id: `pet:${petId}:${stamp}:${index}:${createHash('sha256').update(message.text).digest('hex').slice(0, 8)}`,
      role: message.role,
      author: 'pet',
      text: message.text.slice(0, 2000),
    }));

    try {
      for (let index = 0; index < payload.length; index += INGEST_BATCH) {
        await call('/v1/ingest', { messages: payload.slice(index, index + INGEST_BATCH), scene });
      }
      return true;
    } catch (error) {
      logger?.debug?.(`记忆入库失败：${error?.message ?? error}`);
      return false;
    }
  }

  return {
    recallBlock,
    ingest,
    endpoint,
    scene,
    tokenFile: cfg.tokenFile,
  };
}
