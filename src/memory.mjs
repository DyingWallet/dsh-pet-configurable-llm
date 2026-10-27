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
  const recallK = Number(cfg.recallK) || 5;
  const maxChars = Number(cfg.recallMaxChars) || 1500;
  // "Live" = the newest short-term chat from another scene (the main session),
  // so the pet can tell what the owner is in the middle of. Disabled with
  // `"live": false`.
  const live =
    cfg.live === false
      ? undefined
      : {
          k: Number(cfg.live?.k) || 6,
          minutes: Number(cfg.live?.minutes) || 30,
          scenes: Array.isArray(cfg.live?.scenes) ? cfg.live.scenes : ['main'],
          maxChars: Number(cfg.live?.maxChars) || 400,
        };

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
      // 记忆块由 memd 渲染（format: "block"）：标题、时间、截断、owner 标记都在服务端，
      // 这里不再自己拼——三端共用同一份格式。
      const data = await call('/v1/recall', {
        messages: usable,
        k: recallK,
        max_chars: maxChars,
        scene,
        ...(live ? { live: { k: live.k, minutes: live.minutes, scenes: live.scenes } } : {}),
        format: 'block',
      });
      return typeof data?.block === 'string' ? data.block : '';
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
