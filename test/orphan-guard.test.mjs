import test from 'node:test';
import assert from 'node:assert/strict';
import { createDshGuard, GUARD_DEFAULTS } from '../src/guard.mjs';

function fakeLogger() {
  const lines = [];
  const push = (level) => (message) => lines.push(`${level}: ${message}`);
  return { lines, info: push('info'), warn: push('warn'), error: push('error') };
}

test('连续不可达到达上限后判为孤儿，只回调一次', async () => {
  const logger = fakeLogger();
  let calls = 0;
  const guard = createDshGuard({
    probe: async () => false,
    logger,
    probeMs: 20_000,
    maxMisses: 3,
    onOrphan: () => {
      calls += 1;
    },
  });

  assert.equal(await guard.tick(), 1);
  assert.equal(guard.stopped, false);
  assert.equal(await guard.tick(), 2);
  assert.equal(guard.stopped, false);
  assert.equal(await guard.tick(), 3);
  assert.equal(guard.stopped, true);
  assert.equal(calls, 1);

  // 已经判定孤儿：后续 tick 不再探测、不再回调
  assert.equal(await guard.tick(), 3);
  assert.equal(calls, 1);
  assert.match(logger.lines.join('\n'), /视为孤儿/);
});

test('中途恢复会把计数清零，不会误判', async () => {
  const logger = fakeLogger();
  let calls = 0;
  const answers = [false, false, true, false, false];
  const guard = createDshGuard({
    probe: async () => answers.shift() ?? true,
    logger,
    probeMs: 20_000,
    maxMisses: 3,
    onOrphan: () => {
      calls += 1;
    },
  });

  await guard.tick();
  await guard.tick();
  assert.equal(guard.misses, 2);
  await guard.tick(); // DSH 回来了
  assert.equal(guard.misses, 0);
  assert.equal(guard.stopped, false);
  await guard.tick();
  await guard.tick();
  assert.equal(guard.misses, 2);
  assert.equal(calls, 0);
  assert.match(logger.lines.join('\n'), /孤儿计数清零/);
});

test('probe 抛异常按不可达计，不向上抛', async () => {
  const logger = fakeLogger();
  const guard = createDshGuard({
    probe: async () => {
      throw new Error('boom');
    },
    logger,
    probeMs: 20_000,
    maxMisses: 2,
  });

  assert.equal(await guard.tick(), 1);
  assert.equal(await guard.tick(), 2);
  assert.equal(guard.stopped, true);
  assert.match(logger.lines.join('\n'), /探活异常：boom/);
});

test('stop() 之后不再探测也不再退出', async () => {
  let probes = 0;
  let calls = 0;
  const guard = createDshGuard({
    probe: async () => {
      probes += 1;
      return false;
    },
    logger: fakeLogger(),
    probeMs: 20_000,
    maxMisses: 1,
    onOrphan: () => {
      calls += 1;
    },
  });
  guard.start();
  guard.stop();
  assert.equal(await guard.tick(), 0);
  assert.equal(probes, 0);
  assert.equal(calls, 0);
});

test('间隔下限 5 秒，默认 20 秒 x 3 次（约 60 秒）', () => {
  const guard = createDshGuard({ probe: async () => true, logger: fakeLogger(), probeMs: 10 });
  assert.equal(guard.intervalMs, 5_000);
  assert.equal(guard.limit, GUARD_DEFAULTS.maxMisses);
  assert.equal(GUARD_DEFAULTS.probeMs, 20_000);
  assert.equal(GUARD_DEFAULTS.probeMs * GUARD_DEFAULTS.maxMisses, 60_000);
  guard.stop();
});

test('缺少 probe 直接报错', () => {
  assert.throws(() => createDshGuard({}), /probe/);
});
