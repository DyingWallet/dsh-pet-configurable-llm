import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildMemoryCard } from '../src/memory-card.mjs';

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pet-brain-memory-'));
}

test('buildMemoryCard 汇总 profile / 日志 / 决策，并写入卡文件', () => {
  const root = tempRoot();
  fs.mkdirSync(path.join(root, 'user'), { recursive: true });
  fs.mkdirSync(path.join(root, '10-journal', '2026-10'), { recursive: true });
  fs.mkdirSync(path.join(root, '30-projects'), { recursive: true });
  fs.mkdirSync(path.join(root, '40-decisions'), { recursive: true });
  fs.writeFileSync(path.join(root, 'user', 'profile.md'), '---\ndate: 2026-01-01\n---\n# 70903\n\n主人是 70903。\n');
  fs.writeFileSync(path.join(root, 'user', 'preferences.md'), '先给结论；报告带证据。\n');
  fs.writeFileSync(path.join(root, 'index.md'), '- [profile](user/profile.md)\n');
  fs.writeFileSync(path.join(root, '10-journal', '2026-10', '2026-10-23.md'), '今天在评估桌宠。\n');
  fs.writeFileSync(path.join(root, '30-projects', 'pet.md'), '桌宠项目上下文。\n');
  fs.writeFileSync(path.join(root, '40-decisions', '2026-10-01-0001-x.md'), '决定用只读 preset。\n');

  const cardFile = path.join(root, '.meta', 'pet-memory-card.md');
  const card = buildMemoryCard({ root, cardFile, maxChars: 4000, now: new Date('2026-10-23T00:00:00Z') });
  assert.match(card.text, /70903/);
  assert.match(card.text, /先给结论/);
  assert.match(card.text, /今天在评估桌宠/);
  assert.match(card.text, /只读 preset/);
  assert.equal(card.files.length >= 4, true);
  assert.equal(fs.readFileSync(cardFile, 'utf8'), card.text);
});

test('buildMemoryCard 遵守 maxChars 上限', () => {
  const root = tempRoot();
  fs.mkdirSync(path.join(root, 'user'), { recursive: true });
  fs.writeFileSync(path.join(root, 'user', 'profile.md'), 'x'.repeat(5000));
  const card = buildMemoryCard({ root, cardFile: path.join(root, 'card.md'), maxChars: 1200 });
  assert.equal(card.text.length <= 1200, true);
  assert.match(card.text, /上限/);
});

test('缺失目录时返回带标题的最小卡，不抛错', () => {
  const root = path.join(tempRoot(), 'missing');
  const card = buildMemoryCard({ root, cardFile: path.join(root, 'card.md'), maxChars: 2000 });
  assert.match(card.text, /桌宠的长期记忆卡/);
  assert.equal(card.chars > 0, true);
});
