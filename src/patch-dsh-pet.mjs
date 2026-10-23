// 启动时给 dsh-pet 打「回复优先」补丁（网页 bundle + 桌面 helper 两套渲染栈）。
//
// 问题：气泡位只有一个，两套实现的优先级都是「工作状态（回合结束时）> 回复/碎碎念」，
// 回合结束时工作状态先占位几秒，把刚到的回复盖住。
//
// 网页（lib/client.js）：给两个工作状态分支加 `&& !(whisperBubbleOn && whisperText)`。
// 桌面（runtime/electron-helper/sprite.js）：把 slot 的优先级改成 whisper 先于 work。
// 幂等；dsh-pet 升级后下次启动会重新打。
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MARKER = 'petBrainReplyPriority';

const CLIENT_TARGETS = [
  {
    from: 'if (workTerminal && workBubbleOn && workText && cfg.workStatusEnabled)',
    to: 'if (workTerminal && workBubbleOn && workText && cfg.workStatusEnabled && !(whisperBubbleOn && whisperText))',
  },
  {
    from: 'if (workBubbleOn && workText && cfg.workStatusEnabled)',
    to: 'if (workBubbleOn && workText && cfg.workStatusEnabled && !(whisperBubbleOn && whisperText))',
  },
];

const SPRITE_TARGET = {
  from: "workTerminal && workOn ? 'work' : whisperOn ? 'whisper' : balanceOn ? 'balance' : workOn ? 'work' : 'none'",
  to: "whisperOn ? 'whisper' : workTerminal && workOn ? 'work' : balanceOn ? 'balance' : workOn ? 'work' : 'none'",
};

/** 网页 bundle：返回 { text, status }。 */
export function applyReplyPriorityPatch(source) {
  if (source.includes(MARKER)) return { text: source, status: 'already' };
  let text = source;
  let changed = 0;
  for (const target of CLIENT_TARGETS) {
    if (!text.includes(target.from)) continue;
    text = text.replace(target.from, target.to);
    changed += 1;
  }
  if (changed === 0) return { text: source, status: 'unsupported' };
  text = `${text}\n// ${MARKER}: reply bubble wins over work-status bubbles\n`;
  return { text, status: 'patched' };
}

/** 桌面 helper（sprite.js）：返回 { text, status }。 */
export function applySpritePriorityPatch(source) {
  if (source.includes(MARKER)) return { text: source, status: 'already' };
  if (!source.includes(SPRITE_TARGET.from)) return { text: source, status: 'unsupported' };
  const text =
    source.replace(SPRITE_TARGET.from, SPRITE_TARGET.to) +
    `\n// ${MARKER}: reply bubble wins over work-status bubbles\n`;
  return { text, status: 'patched' };
}

function patchFile(file, apply, logger, label) {
  if (!existsSync(file)) return { status: 'missing', file };
  const source = readFileSync(file, 'utf8');
  const result = apply(source);
  if (result.status !== 'patched') {
    logger?.debug?.(`dsh-pet ${label} 补丁状态：${result.status}（${file}）`);
    return { status: result.status, file };
  }
  const backup = `${file}.bak-petbrain`;
  if (!existsSync(backup)) {
    copyFileSync(file, backup);
    logger?.info?.(`已备份 dsh-pet ${label}：${backup}`);
  }
  writeFileSync(file, result.text, 'utf8');
  logger?.info?.(`已给 dsh-pet ${label} 打上「回复优先」补丁`);
  return { status: 'patched', file };
}

/**
 * 给已安装的 dsh-pet 打补丁（网页 + 桌面两套）。
 * @param {{ dshHome?: string, profile?: string, clientPath?: string, spritePath?: string, logger?: any }} [options]
 */
export function patchDshPetClient(options = {}) {
  const logger = options.logger;
  const dshHome = options.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');
  const profile = options.profile ?? process.env.DSH_PROFILE ?? 'desktop';
  const pkg = join(dshHome, 'profiles', profile, 'node_modules', 'dsh-pet');
  const client = patchFile(options.clientPath || join(pkg, 'lib', 'client.js'), applyReplyPriorityPatch, logger, 'client');
  const sprite = patchFile(
    options.spritePath || join(pkg, 'runtime', 'electron-helper', 'sprite.js'),
    applySpritePriorityPatch,
    logger,
    'desktop helper',
  );
  return { client, sprite };
}
