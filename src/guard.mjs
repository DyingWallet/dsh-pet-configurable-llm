// 孤儿保护：模型服务（8790）只服务 DSH 的 pet-chat preset，DSH 不在就没有调用方。
//
// v2 自启方案 B（2026-10-24 决定）：本服务由 qq-bridge\start-stack.ps1 在 DSH
// 之后拉起，不做独立登录任务；DSH 关闭/崩溃后由这里每 20 秒探一次，连续 3 次
// 不可达（约 60 秒）就自己退出，避免留下占着 8790 的僵尸后端。
//
// 为什么不挂 DSH 进程：DSH 的 fail-loud 会把宿主插件的未捕获异常当成致命错误退出
// 整个 app（dsh-memory/lib/index.js 的注释记录了 2026-10-24 那次事故），为了顺带
// 启动一个后端而把进程管理塞进 DSH 进程内，风险不对称。
//
// 探活只做到「端点可达」这一层（本服务的 `probe()`），不打 RPC：DSH 桌面版每次重启换随机端口，
// 探测会用自动发现把它认出来；认不出来才算一次 miss，所以 DSH 正常重启不会误杀本服务。

export const GUARD_DEFAULTS = Object.freeze({ probeMs: 20_000, maxMisses: 3 });

/**
 * @param {object} options
 * @param {() => Promise<boolean>} options.probe 一次存活探测，true 表示 DSH 可达
 * @param {{info?:Function,warn?:Function,error?:Function}} [options.logger]
 * @param {number} [options.probeMs] 探测间隔，默认 20 秒（下限 5 秒）
 * @param {number} [options.maxMisses] 连续多少次不可达退出，默认 3
 * @param {(misses:number) => any} [options.onOrphan] 判定为孤儿后的处理（默认只记日志）
 */
export function createDshGuard({ probe, logger, probeMs, maxMisses, onOrphan } = {}) {
  if (typeof probe !== 'function') throw new Error('createDshGuard 需要 probe()');

  const intervalMs = Math.max(5_000, Math.floor(Number(probeMs) || GUARD_DEFAULTS.probeMs));
  const limit = Math.max(1, Math.floor(Number(maxMisses) || GUARD_DEFAULTS.maxMisses));

  let misses = 0;
  let stopped = false;
  let busy = false;
  let timer = null;

  function clearTimer() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  /** 跑一次探测；测试里直接调它，不依赖定时器。返回累计 miss 数。 */
  async function tick() {
    if (stopped || busy) return misses;
    busy = true;
    let alive = false;
    try {
      alive = (await probe()) === true;
    } catch (error) {
      logger?.warn?.(`DSH 探活异常：${error?.message ?? error}`);
    } finally {
      busy = false;
    }
    if (stopped) return misses;

    if (alive) {
      if (misses > 0) logger?.info?.(`DSH 恢复可达，孤儿计数清零（之前 ${misses}/${limit}）`);
      misses = 0;
      return misses;
    }

    misses += 1;
    if (misses < limit) {
      const left = Math.round((intervalMs * (limit - misses)) / 1000);
      logger?.warn?.(`DSH 不可达（${misses}/${limit}），约 ${left} 秒后退出`);
      return misses;
    }

    stopped = true;
    clearTimer();
    logger?.warn?.(`DSH 连续 ${limit} 次不可达（约 ${Math.round((intervalMs * limit) / 1000)} 秒），模型服务视为孤儿，退出`);
    try {
      await onOrphan?.(misses);
    } catch (error) {
      logger?.error?.(`孤儿退出处理失败：${error?.message ?? error}`);
    }
    return misses;
  }

  function start() {
    if (stopped || timer) return false;
    timer = setInterval(() => void tick(), intervalMs);
    timer.unref?.();
    logger?.info?.(
      `孤儿保护已启用：每 ${Math.round(intervalMs / 1000)} 秒探一次 DSH，连续 ${limit} 次不可达即退出`,
    );
    return true;
  }

  function stop() {
    stopped = true;
    clearTimer();
  }

  return {
    start,
    stop,
    tick,
    intervalMs,
    limit,
    get misses() {
      return misses;
    },
    get stopped() {
      return stopped;
    },
  };
}
