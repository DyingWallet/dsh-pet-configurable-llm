// DSH 会话层：把「一只桌宠」映射到「一条专用 DSH 会话」。
//
// 复用 qq-bridge 已经跑通的传输层（Cookie 离线铸造、随机端口发现、session RPC、
// /api/remote.mux 事件流），本文件只负责：
//   - 建/复用会话（workspace + agentPreset，fail-closed）
//   - 发 prompt、收 turn 事件、超时/取消
//   - 会话 ID 持久化（DSH 重启后还能接上）
//   - 健康检查与端口漂移后的重建
import fs from 'node:fs';
import path from 'node:path';
import { NodeApiClient, unwrap } from './dsh/client.mjs';
import { resolveDshBaseUrl } from './dsh/endpoint.mjs';

const FOLLOW_REFRESH_MS = 30_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function textOfMessage(message) {
  const blocks = message?.content;
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

function reasonKind(reason) {
  if (typeof reason === 'string') return reason;
  if (reason && typeof reason === 'object' && typeof reason.kind === 'string') return reason.kind;
  return 'unknown';
}

function sessionNotFound(error) {
  const message = String(error?.message ?? error ?? '');
  return /session\/not-found|not[- ]?found|会话不存在|session not found/i.test(message);
}

export class DshAgent {
  /**
   * @param {object} options
   * @param {object} options.config 完整配置
   * @param {object} options.logger
   * @param {string} options.stateDir
   */
  constructor({ config, logger, stateDir }) {
    this.config = config;
    this.logger = logger;
    this.stateDir = stateDir;
    this.stateFile = path.join(stateDir, 'sessions.json');
    this.baseUrl = '';
    this.api = null;
    this.muxAbort = null;
    this.muxReady = null;
    this.muxTask = null;
    this.closed = false;

    /** petId -> sessionId */
    this.sessions = new Map();
    /** petId -> { bootstrapped: boolean, createdAt, updatedAt } */
    this.meta = new Map();
    /** petId -> Promise（建会话并发保护） */
    this.createLocks = new Map();
    /** petId -> Promise（同宠物串行） */
    this.promptLocks = new Map();
    /** sessionId -> waiter */
    this.pending = new Map();
    /** 已 follow 的会话 */
    this.followed = new Map();
    this.presets = [];
    this.lastDiscoverAt = 0;
    this.loadState();
  }

  loadState() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      for (const [petId, entry] of Object.entries(raw?.pets ?? {})) {
        if (entry && typeof entry.sessionId === 'string' && entry.sessionId) {
          this.sessions.set(petId, entry.sessionId);
          this.meta.set(petId, {
            bootstrapped: entry.bootstrapped === true,
            createdAt: Number(entry.createdAt) || 0,
            updatedAt: Number(entry.updatedAt) || 0,
          });
        }
      }
    } catch {
      // 首次启动/文件损坏：空状态即可，下一次会重建会话
    }
  }

  saveState() {
    const pets = {};
    for (const [petId, sessionId] of this.sessions) {
      const meta = this.meta.get(petId) ?? {};
      pets[petId] = {
        sessionId,
        bootstrapped: meta.bootstrapped === true,
        createdAt: meta.createdAt || 0,
        updatedAt: Date.now(),
      };
    }
    try {
      fs.mkdirSync(this.stateDir, { recursive: true });
      const tmp = this.stateFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, pets }, null, 2), 'utf8');
      fs.renameSync(tmp, this.stateFile);
    } catch (error) {
      this.logger.warn(`会话状态写入失败：${error?.message ?? error}`);
    }
  }

  async ensureClient({ force = false } = {}) {
    if (this.closed) throw new Error('模型服务已关闭');
    // DSH_WEB_URL 是 DSH 自己注入给子进程的当前地址（桌面版每次重启换端口）；
    // 服务由登录项/手动启动时没有这个变量，就回落到配置或自动发现。
    const configured =
      String(this.config.dsh.baseUrl ?? '').trim() || String(process.env.DSH_WEB_URL ?? '').trim();
    const now = Date.now();
    if (!force && this.api && now - this.lastDiscoverAt < this.config.dsh.rediscoverMs) return this.api;

    let resolved = await resolveDshBaseUrl(configured, { timeoutMs: 800, discover: true });
    // 配置里写了固定端口，但 DSH 桌面版重启后换了端口：固定地址不可达时再走一次自动发现。
    if (!resolved.reachable && configured) {
      const discovered = await resolveDshBaseUrl('', { timeoutMs: 800, discover: true });
      if (discovered.reachable) resolved = discovered;
    }
    if (!resolved.reachable) {
      throw new Error(
        `DSH 不可达（候选：${resolved.candidates.join(', ')}）。请确认 DSH 桌面版正在运行，或配置 dsh.baseUrl。`,
      );
    }
    if (force || resolved.url !== this.baseUrl || !this.api) {
      this.baseUrl = resolved.url;
      this.api = new NodeApiClient(this.baseUrl, 15_000, {});
      this.logger.info(`DSH 端点：${this.baseUrl}${resolved.discovered ? '（自动发现）' : ''}`);
    }
    this.lastDiscoverAt = now;
    return this.api;
  }

  async start() {
    const api = await this.ensureClient({ force: true });
    let listed;
    try {
      listed = unwrap(await api.agentPresets.list({}), 'agentPresets/list');
    } catch (error) {
      throw new Error(`读取 DSH agent preset 失败：${error?.message ?? error}`);
    }
    this.presets = (listed?.presets ?? []).map((preset) => preset.id).filter(Boolean);
    if (!this.presets.includes(this.config.dsh.agentPreset)) {
      throw new Error(
        `agent preset "${this.config.dsh.agentPreset}" 不在 DSH 可用清单中（${this.presets.join(', ') || '空'}）。` +
          `拒绝回退到 standard（会暴露 shell/写文件）；请先安装 pet-chat preset 并重启 DSH。`,
      );
    }
    this.logger.info(`可用 preset：${this.presets.join(', ')}；使用：${this.config.dsh.agentPreset}`);
    await this.startMux();
    // 把已持久化的会话重新 follow（DSH 重启后事件流是新的，必须重放）
    for (const sessionId of this.sessions.values()) this.follow(sessionId);
    return this;
  }

  async startMux() {
    if (this.muxTask) return;
    this.muxAbort = new AbortController();
    this.muxReady = new Promise((resolve) => {
      this._resolveMuxReady = resolve;
    });
    this.muxTask = (async () => {
      let retry = 1_000;
      while (!this.closed && !this.muxAbort.signal.aborted) {
        try {
          // 重连时强制重新发现端口（DSH 桌面版每次重启换随机端口）。
          const api = await this.ensureClient({ force: this.api !== null && Date.now() - this.lastDiscoverAt > 5_000 });
          for await (const envelope of api.events.mux({}, this.muxAbort.signal, () => {
            this._resolveMuxReady?.();
          })) {
            retry = 1_000;
            this.handleEnvelope(envelope);
          }
        } catch (error) {
          if (this.closed || this.muxAbort.signal.aborted) break;
          this.logger.warn(`DSH 事件流断开：${error?.message ?? error}；${retry}ms 后重连`);
          await sleep(retry);
          retry = Math.min(retry * 2, 15_000);
        }
      }
    })();
  }

  handleEnvelope(envelope) {
    const frame = envelope?.payload ?? envelope;
    if (!frame || typeof frame !== 'object') return;
    if (frame.type === 'session/event') {
      this.handleSessionEvent(frame.sessionId, frame.event);
    }
  }

  handleSessionEvent(sessionId, event) {
    const waiter = this.pending.get(sessionId);
    if (!waiter || !event) return;
    if (event.type === 'turn/start') {
      waiter.started = true;
      waiter.turn = event.data?.turn;
      return;
    }
    // 已经锁定 turn 时，忽略别的回合的迟到事件（事件流重连/旧回合收尾都可能发生）。
    if (waiter.turn !== undefined && event.data?.turn !== undefined && event.data.turn !== waiter.turn) return;
    if (event.type === 'assistant/message') {
      const text = textOfMessage(event.data?.message);
      if (!text) return;
      waiter.text += text;
      if (waiter.onDelta) {
        try {
          waiter.onDelta(text);
        } catch (error) {
          this.logger.warn(`onDelta 失败：${error?.message ?? error}`);
        }
      }
      return;
    }
    if (event.type === 'turn/end') {
      const kind = reasonKind(event.data?.reason);
      this.finishWaiter(sessionId, {
        ok: kind === 'completed' && waiter.text.trim().length > 0,
        text: waiter.text,
        reason: kind,
      });
      return;
    }
    if (event.type === 'error' || event.type === 'session/error') {
      this.finishWaiter(sessionId, {
        ok: false,
        text: waiter.text,
        reason: 'error',
        message: String(event.data?.message ?? event.data?.error ?? 'DSH 返回错误'),
      });
    }
  }

  finishWaiter(sessionId, result) {
    const waiter = this.pending.get(sessionId);
    if (!waiter) return;
    this.pending.delete(sessionId);
    clearTimeout(waiter.timer);
    waiter.signal?.removeEventListener('abort', waiter.onAbort);
    waiter.resolve(result);
  }

  follow(sessionId) {
    if (!sessionId) return;
    try {
      this.api?.events.follow(sessionId);
      this.followed.set(sessionId, Date.now());
    } catch (error) {
      this.logger.warn(`follow 失败 ${sessionId}: ${error?.message ?? error}`);
    }
  }

  async waitForMux(timeoutMs = 3000) {
    if (!this.muxReady) return;
    await Promise.race([this.muxReady, sleep(Math.max(200, timeoutMs))]);
  }

  async withPromptLock(petId, fn) {
    const previous = this.promptLocks.get(petId) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const chained = previous.then(() => gate);
    this.promptLocks.set(petId, chained);
    await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      if (this.promptLocks.get(petId) === chained) this.promptLocks.delete(petId);
    }
  }

  async ensureSession(petId) {
    if (this.sessions.has(petId)) return this.sessions.get(petId);
    if (this.createLocks.has(petId)) return this.createLocks.get(petId);
    const task = (async () => {
      const api = await this.ensureClient();
      if (!this.presets.includes(this.config.dsh.agentPreset)) {
        throw new Error(`preset "${this.config.dsh.agentPreset}" 不可用，拒绝建会话`);
      }
      const workspace = unwrap(
        await api.workspace.create({ path: this.config.dsh.workspacePath }),
        'workspace/create',
      );
      const workspaceId = workspace?.workspace?.workspaceId;
      if (!workspaceId) throw new Error('workspace/create 没有返回 workspaceId');
      const created = unwrap(
        await api.sessions.create({ workspaceId, agentPreset: this.config.dsh.agentPreset }),
        'session/create',
      );
      const sessionId = created?.sessionId;
      if (!sessionId) throw new Error('session/create 没有返回 sessionId');

      this.sessions.set(petId, sessionId);
      this.meta.set(petId, { bootstrapped: false, createdAt: Date.now(), updatedAt: Date.now() });
      this.saveState();
      this.follow(sessionId);

      try {
        await api.callUnary('session.rename', { sessionId, title: `${this.config.identity?.name ?? '桌宠'}·LLM` });
      } catch (error) {
        this.logger.warn(`会话改名失败（不影响使用）：${error?.message ?? error}`);
      }

      // 只读权限预设：纵深防御；preset 里的工具守卫才是硬边界。
      try {
        const result = unwrap(await api.commands.execute(sessionId, '/permission read-only'), 'commands/execute');
        const ok = result?.result?.kind === 'success' || result?.result?.text === undefined;
        if (!ok) this.logger.warn(`/permission read-only 返回：${JSON.stringify(result?.result ?? result)}`);
      } catch (error) {
        this.logger.warn(`/permission read-only 设置失败：${error?.message ?? error}`);
      }

      const model = this.config.dsh.model;
      if (model?.provider && model?.model) {
        // 两个 id 都拦：`pet-llm` 是现在的 provider，`pet-brain` 是改名前的老配置，
        // 残留一份都会造成本服务里的 DSH 会话调回本服务。
        if (/^(pet-llm|pet-brain)$/.test(String(model.provider))) {
          throw new Error(
            `dsh.model.provider 指向 ${model.provider} 会造成自我递归；请改成 DeepSeek 的 provider`,
          );
        }
        try {
          const selected = unwrap(
            await api.sessions.selectModel({ sessionId, provider: model.provider, model: model.model }),
            'session/selectModel',
          );
          this.logger.info(
            `会话模型：${selected?.selected?.provider ?? model.provider}/${selected?.selected?.model ?? model.model}`,
          );
        } catch (error) {
          this.logger.warn(`会话模型设置失败（将用 DSH 默认模型）：${error?.message ?? error}`);
        }
      }

      this.logger.info(`已创建 ${petId} 的 DSH 会话 ${sessionId}（preset ${this.config.dsh.agentPreset}）`);
      return sessionId;
    })();
    this.createLocks.set(petId, task);
    try {
      return await task;
    } finally {
      if (this.createLocks.get(petId) === task) this.createLocks.delete(petId);
    }
  }

  isBootstrapped(petId) {
    return this.meta.get(petId)?.bootstrapped === true;
  }

  markBootstrapped(petId) {
    const meta = this.meta.get(petId);
    if (!meta) return;
    meta.bootstrapped = true;
    meta.updatedAt = Date.now();
    this.saveState();
  }

  forgetSession(petId) {
    const sessionId = this.sessions.get(petId);
    if (sessionId) {
      this.pending.delete(sessionId);
      this.followed.delete(sessionId);
      try {
        this.api?.events.forget(sessionId);
      } catch {
        // ignore
      }
    }
    this.sessions.delete(petId);
    this.meta.delete(petId);
    this.saveState();
  }

  async resetSession(petId) {
    const sessionId = this.sessions.get(petId);
    if (!sessionId) return;
    try {
      await this.stopSessionWork(sessionId);
    } catch {
      // ignore
    }
    try {
      await this.api?.workspace.archiveSession({ sessionId });
    } catch {
      // ignore
    }
    this.forgetSession(petId);
  }

  async stopSessionWork(sessionId) {
    if (!sessionId || !this.api) return;
    try {
      await this.api.stopSessionWork(sessionId, { timeoutMs: 8_000 });
    } catch (error) {
      this.logger.warn(`取消会话工作失败 ${sessionId}: ${error?.message ?? error}`);
    }
  }

  /**
   * 给一只桌宠发一句话，等 DSH 回合结束。
   * @param {string} petId
   * @param {string} text
   * @param {{signal?: AbortSignal, onDelta?: (text: string) => void}} [options]
   * @returns {Promise<{ok: boolean, text: string, reason: string, message?: string}>}
   */
  async prompt(petId, text, options = {}) {
    return this.withPromptLock(petId, async () => {
      let attempt = 0;
      for (;;) {
        attempt += 1;
        try {
          const result = await this.promptOnce(petId, text, options);
          // DSH 把整个会话判成 blocked（turn/end 的 reason.kind=blocked，且没有正文）时，
          // /clear、/compact、重选模型都解不开——那是会话状态坏了。换一个新会话重试一次，
          // 不把坏会话的问题甩给用户（桌宠侧只会看到「连不上模型」）。
          if (!result.ok && result.reason === 'blocked' && attempt <= 2) {
            this.logger.warn(`会话被 DSH 判为 blocked，重建 ${petId}（第 ${attempt} 次）`);
            this.forgetSession(petId);
            continue;
          }
          return result;
        } catch (error) {
          if (attempt === 1 && sessionNotFound(error)) {
            this.logger.warn(`会话已失效，重建 ${petId}`);
            this.forgetSession(petId);
            continue;
          }
          return {
            ok: false,
            text: '',
            reason: 'error',
            message: error instanceof Error ? error.message : String(error),
          };
        }
      }
    });
  }

  async promptOnce(petId, text, options) {
    const api = await this.ensureClient();
    const sessionId = await this.ensureSession(petId);
    this.follow(sessionId);
    // 事件流没连上就发 prompt 会丢 turn/start，等一小会儿（连上后即 resolve）。
    await this.waitForMux(3000);

    // 同一会话还有未收尾的回合：先取消，避免 queue 到旧 turn 后面。
    if (this.pending.has(sessionId)) {
      await this.stopSessionWork(sessionId);
      await sleep(150);
    }

    const signal = options.signal;
    if (signal?.aborted) return { ok: false, text: '', reason: 'aborted' };

    const result = await new Promise((resolve) => {
      const waiter = {
        text: '',
        started: false,
        onDelta: options.onDelta,
        signal,
        resolve,
        timer: null,
        onAbort: null,
      };
      waiter.timer = setTimeout(() => {
        void this.stopSessionWork(sessionId);
        this.finishWaiter(sessionId, { ok: false, text: waiter.text, reason: 'timeout' });
      }, this.config.dsh.timeoutMs);
      if (signal) {
        waiter.onAbort = () => {
          void this.stopSessionWork(sessionId);
          this.finishWaiter(sessionId, { ok: false, text: waiter.text, reason: 'aborted' });
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.pending.set(sessionId, waiter);

      void (async () => {
        try {
          unwrap(
            await api.sessions.prompt({
              sessionId,
              mode: 'queue',
              content: [{ type: 'text', text }],
            }),
            'session/prompt',
          );
        } catch (error) {
          this.finishWaiter(sessionId, {
            ok: false,
            text: '',
            reason: 'error',
            message: error instanceof Error ? error.message : String(error),
          });
        }
      })();
    });

    if (!result.ok && result.reason === 'aborted') {
      throw Object.assign(new Error('已取消'), { name: 'AbortError' });
    }
    return result;
  }

  /**
   * 轻量存活探测：只确认「DSH 端点可达」，不打任何 RPC，也不改 this.api。
   * 供孤儿保护（guard.mjs）使用——DSH 桌面版每次重启换随机端口，固定地址不通时
   * 再走一次自动发现，所以正常重启不会被误判成下线。
   */
  async probe() {
    if (this.closed) return false;
    const configured = String(this.config.dsh.baseUrl ?? '').trim() || String(process.env.DSH_WEB_URL ?? '').trim();
    const candidates = [];
    for (const candidate of [configured || this.baseUrl, '']) {
      if (!candidates.includes(candidate)) candidates.push(candidate);
    }
    for (const candidate of candidates) {
      try {
        const resolved = await resolveDshBaseUrl(candidate, { timeoutMs: 800, discover: true });
        if (resolved.reachable === true) return true;
      } catch {
        // 换下一个候选
      }
    }
    return false;
  }

  async health() {
    try {
      const api = await this.ensureClient();
      const listed = unwrap(await api.agentPresets.list({}), 'agentPresets/list');
      return {
        reachable: true,
        baseUrl: this.baseUrl,
        presets: (listed?.presets ?? []).map((preset) => preset.id),
        sessions: Object.fromEntries(this.sessions),
      };
    } catch (error) {
      return {
        reachable: false,
        baseUrl: this.baseUrl,
        error: error instanceof Error ? error.message : String(error),
        sessions: Object.fromEntries(this.sessions),
      };
    }
  }

  async close() {
    this.closed = true;
    this.muxAbort?.abort();
    for (const [sessionId, waiter] of this.pending) {
      this.finishWaiter(sessionId, { ok: false, text: waiter.text, reason: 'shutdown' });
    }
    try {
      await this.muxTask;
    } catch {
      // ignore
    }
  }
}

export { sleep };
