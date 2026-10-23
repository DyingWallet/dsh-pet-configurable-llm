import test from 'node:test';
import assert from 'node:assert/strict';
import { applyReplyPriorityPatch, applySpritePriorityPatch } from '../src/patch-dsh-pet.mjs';

const SAMPLE = [
  'if (workTerminal && workBubbleOn && workText && cfg.workStatusEnabled) return h(WhisperBubble, { text: workText, on: workBubbleOn });',
  'if (whisperBubbleOn && whisperText) return h(WhisperBubble, { text: whisperText, on: whisperBubbleOn });',
  'if (workBubbleOn && workText && cfg.workStatusEnabled) return h(WhisperBubble, { text: workText, on: workBubbleOn });',
].join('\n');

test('给两个工作状态分支加上「有回复时让位」', () => {
  const result = applyReplyPriorityPatch(SAMPLE);
  assert.equal(result.status, 'patched');
  assert.match(result.text, /workTerminal[^\n]*workStatusEnabled && !\(whisperBubbleOn && whisperText\)/);
  assert.match(result.text, /if \(workBubbleOn && workText && cfg\.workStatusEnabled && !\(whisperBubbleOn && whisperText\)\)/);
  assert.match(result.text, /petBrainReplyPriority/);
});

test('幂等：第二次不再改动', () => {
  const first = applyReplyPriorityPatch(SAMPLE);
  const second = applyReplyPriorityPatch(first.text);
  assert.equal(second.status, 'already');
  assert.equal(second.text, first.text);
});

test('版本变了就跳过，不抛错', () => {
  const result = applyReplyPriorityPatch('if (somethingElse) return null;');
  assert.equal(result.status, 'unsupported');
  assert.equal(result.text, 'if (somethingElse) return null;');
});

const SPRITE_SAMPLE =
  "const slot = workTerminal && workOn ? 'work' : whisperOn ? 'whisper' : balanceOn ? 'balance' : workOn ? 'work' : 'none';";

test('桌面 helper：回复优先于工作状态', () => {
  const result = applySpritePriorityPatch(SPRITE_SAMPLE);
  assert.equal(result.status, 'patched');
  assert.match(result.text, /whisperOn \? 'whisper' : workTerminal && workOn \? 'work'/);
  assert.match(result.text, /petBrainReplyPriority/);
});

test('桌面 helper 幂等', () => {
  const first = applySpritePriorityPatch(SPRITE_SAMPLE);
  const second = applySpritePriorityPatch(first.text);
  assert.equal(second.status, 'already');
});

test('桌面 helper 版本变了就跳过', () => {
  const result = applySpritePriorityPatch('const slot = whatever;');
  assert.equal(result.status, 'unsupported');
});
