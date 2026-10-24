import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pet-llm-config-'));
}

test('默认配置可用，并生成/复用本地令牌', () => {
  const dir = tempDir();
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      dsh: { baseUrl: 'http://127.0.0.1:1', workspacePath: dir, agentPreset: 'pet-chat' },
      memory: { root: path.join(dir, 'memories'), cardFile: path.join(dir, 'card.md') },
      log: { file: path.join(dir, 'log.txt') },
    }),
  );
  const first = loadConfig({ configPath, env: { PET_BRAIN_STATE_DIR: path.join(dir, 'state') } });
  assert.equal(first.config.dsh.agentPreset, 'pet-chat');
  assert.equal(first.config.memory.root, path.join(dir, 'memories'));
  assert.equal(first.token.length >= 16, true);
  const second = loadConfig({ configPath, env: { PET_BRAIN_STATE_DIR: path.join(dir, 'state') } });
  assert.equal(second.token, first.token);
});

test('拒绝空 preset（fail-closed）', () => {
  const dir = tempDir();
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ dsh: { agentPreset: '' } }));
  assert.throws(() => loadConfig({ configPath, env: { PET_BRAIN_STATE_DIR: dir } }), /agentPreset/);
});

test('拒绝未知 defaultModel', () => {
  const dir = tempDir();
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ models: { xi: 'main' }, defaultModel: 'nope' }));
  assert.throws(() => loadConfig({ configPath, env: { PET_BRAIN_STATE_DIR: dir } }), /defaultModel/);
});
