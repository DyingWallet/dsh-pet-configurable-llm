import test from 'node:test';
import assert from 'node:assert/strict';
import { degradedText, DEGRADED_REPLY } from '../src/degraded.mjs';

test('默认给出一句降级文案', () => {
  assert.equal(degradedText({}), DEGRADED_REPLY.text);
  assert.equal(degradedText({ degradedReply: {} }), DEGRADED_REPLY.text);
  assert.equal(DEGRADED_REPLY.enabled, true);
});

test('配置了文案就用配置的', () => {
  assert.equal(degradedText({ degradedReply: { text: '  等我一下  ' } }), '等我一下');
});

test('显式关闭或 env=0 时返回空串（按错误返回）', () => {
  assert.equal(degradedText({ degradedReply: { enabled: false, text: 'x' } }), '');
  assert.equal(degradedText({ degradedReply: { enabled: true, text: 'x' } }, { PET_BRAIN_DEGRADED_REPLY: '0' }), '');
});

test('空文案回落到默认文案', () => {
  assert.equal(degradedText({ degradedReply: { text: '   ' } }), DEGRADED_REPLY.text);
});
