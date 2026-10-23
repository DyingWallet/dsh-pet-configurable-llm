// 长期记忆卡：把 memories/ 里最该被桌宠知道的内容压成一张可读的卡。
//
// 设计原则：
//  - 卡是**摘录**，不是全量；完整内容仍在 memories/，由只读工具按需读取。
//  - 卡只读 memories/ 下的 Markdown；不碰 .credentials / state / 日志。
//  - 卡每次生成都覆盖写 memories/.meta/pet-memory-card.md，便于人肉检查与回滚。
//  - 预算优先给“我是谁 / 用户是谁 / 最近发生什么”，项目与决策按需截断。
import fs from 'node:fs';
import path from 'node:path';

const SECTION_LIMITS = {
  profile: 2600,
  preferences: 1600,
  index: 2600,
  journals: 3600,
  projects: 2200,
  decisions: 2200,
  people: 1200,
  live: 1600,
};

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function stripFrontMatter(text) {
  if (!text.startsWith('---')) return text;
  const end = text.indexOf('\n---', 3);
  if (end < 0) return text;
  return text.slice(end + 4).replace(/^\s+/, '');
}

function truncate(text, max, label) {
  const clean = String(text ?? '').trim();
  if (clean.length <= max) return clean;
  const suffix = `\n…（已截断，完整内容见 ${label}）`;
  return clean.slice(0, Math.max(0, max - suffix.length)).trimEnd() + suffix;
}

function listMarkdown(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => {
        const file = path.join(dir, entry.name);
        return { file, name: entry.name, mtime: fs.statSync(file).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
}

function listJournalFiles(root) {
  const monthDir = path.join(root, '10-journal');
  let months = [];
  try {
    months = fs
      .readdirSync(monthDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
  const files = [];
  for (const month of months) {
    for (const item of listMarkdown(path.join(monthDir, month))) files.push(item);
    if (files.length >= 4) break;
  }
  return files.sort((a, b) => b.mtime - a.mtime).slice(0, 2);
}

function section(title, body, limit, source) {
  if (!body || !body.trim()) return '';
  return `## ${title}\n${truncate(body, limit, source)}\n`;
}

/**
 * @param {{root: string, cardFile: string, maxChars: number, now?: Date}} options
 * @returns {{text: string, files: string[], generatedAt: string, chars: number}}
 */
export function buildMemoryCard(options) {
  const root = path.resolve(options.root);
  const now = options.now ?? new Date();
  const maxChars = Math.max(1000, Number(options.maxChars) || 16_000);
  const files = [];
  const add = (file) => {
    if (!files.includes(file)) files.push(file);
  };

  const profileFile = path.join(root, 'user', 'profile.md');
  const preferencesFile = path.join(root, 'user', 'preferences.md');
  const indexFile = path.join(root, 'index.md');
  const liveFile = path.join(root, '00-inbox', 'live-context.md');
  const journals = listJournalFiles(root);
  const projects = listMarkdown(path.join(root, '30-projects')).slice(0, 4);
  const decisions = listMarkdown(path.join(root, '40-decisions')).slice(0, 5);
  const people = listMarkdown(path.join(root, '20-people')).slice(0, 3);

  const parts = [];
  parts.push(
    `# ${options.name ?? '桌宠'}的长期记忆卡\n\n> 自动生成于 ${now.toISOString()}。这是摘录，不是全量；完整内容在 ${root}。\n` +
      `> 需要细节时用只读工具读 \`${path.join(root, 'index.md')}\` 或对应文件；不要凭猜测补细节。\n`,
  );

  const profile = readText(profileFile);
  if (profile) {
    add(profileFile);
    parts.push(section('用户（profile）', stripFrontMatter(profile), SECTION_LIMITS.profile, profileFile));
  }
  const preferences = readText(preferencesFile);
  if (preferences) {
    add(preferencesFile);
    parts.push(section('沟通与工作偏好', stripFrontMatter(preferences), SECTION_LIMITS.preferences, preferencesFile));
  }
  const index = readText(indexFile);
  if (index) {
    add(indexFile);
    parts.push(section('记忆索引', stripFrontMatter(index), SECTION_LIMITS.index, indexFile));
  }

  if (journals.length) {
    const body = journals
      .map((item) => {
        add(item.file);
        return `### ${path.basename(item.file, '.md')}\n${stripFrontMatter(readText(item.file))}`;
      })
      .join('\n');
    parts.push(section('最近日志', body, SECTION_LIMITS.journals, journals[0].file));
  }

  if (projects.length) {
    const body = projects
      .map((item) => {
        add(item.file);
        return `### ${path.basename(item.file, '.md')}\n${stripFrontMatter(readText(item.file))}`;
      })
      .join('\n');
    parts.push(section('项目上下文', body, SECTION_LIMITS.projects, projects[0].file));
  }

  if (decisions.length) {
    const body = decisions
      .map((item) => {
        add(item.file);
        return `### ${path.basename(item.file, '.md')}\n${stripFrontMatter(readText(item.file))}`;
      })
      .join('\n');
    parts.push(section('近期决策', body, SECTION_LIMITS.decisions, decisions[0].file));
  }

  if (people.length) {
    const body = people
      .map((item) => {
        add(item.file);
        return `### ${path.basename(item.file, '.md')}\n${stripFrontMatter(readText(item.file))}`;
      })
      .join('\n');
    parts.push(section('相关的人', body, SECTION_LIMITS.people, people[0].file));
  }

  const live = readText(liveFile);
  if (live.trim()) {
    add(liveFile);
    parts.push(section('当前上下文（live-context）', stripFrontMatter(live), SECTION_LIMITS.live, liveFile));
  }

  let text = parts.join('\n').trim() + '\n';
  if (text.length > maxChars) {
    const suffix = `\n…（记忆卡达到 ${maxChars} 字上限，完整内容见 ${root}）\n`;
    text = text.slice(0, Math.max(0, maxChars - suffix.length)).trimEnd() + suffix;
  }

  try {
    fs.mkdirSync(path.dirname(options.cardFile), { recursive: true });
    const tmp = options.cardFile + '.tmp';
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, options.cardFile);
  } catch {
    // 卡写不进去不影响本次注入（内存里仍有 text）
  }

  return { text, files, generatedAt: now.toISOString(), chars: text.length };
}

/** 读卡文件（给 /health 或调试用）；不存在返回空串。 */
export function readMemoryCard(file) {
  return readText(file);
}
