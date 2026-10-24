// 降级文案：模型服务内部失败时**不要**报错，而是用一句明确的「我暂时不行」当正常回复。
//
// 为什么：dsh-pet 的 generateChat 在 provider 报错时会回落到「当前对话模型」再试一次
// （src/host/chat.ts: modelCandidates 里 preferred 后面还 push 了 agentDefaultModel）。
// 也就是说模型服务一旦返回 502/SSE error，桌宠会用普通 DeepSeek 模型接着说话——
// 看起来还是桌宠，背后却不是那条 DSH 会话（没有 AGENTS.md、没有 memories）。
//
// 我们改不了 dsh-pet（决定：不碰它的源码），但能改自己的失败形态：返回 200 + 一段
// 说明文字，它就认为生成成功，永远不会去试第二个候选。
//
// 边界：这条只覆盖「模型服务进程活着、内部失败」的情况。进程本身不在
// （端口没人听）时，请求在 DSH 那层就连不上，dsh-pet 必然回落——那一半靠
// scripts/revive.mjs 的 1 分钟看护把窗口压掉。

export const DEGRADED_REPLY = Object.freeze({
  enabled: true,
  text: '（我这边模型暂时连不上，等我一下下再问我…）',
});

/**
 * 取本次要用的降级文案；返回空串表示「不降级，按错误返回」。
 * @param {{degradedReply?: {enabled?: boolean, text?: string}}} [config]
 * @param {NodeJS.ProcessEnv} [env]
 */
export function degradedText(config, env = process.env) {
  if (env.PET_BRAIN_DEGRADED_REPLY === '0') return '';
  const settings = config?.degradedReply ?? {};
  if (settings.enabled === false) return '';
  const text = typeof settings.text === 'string' ? settings.text.trim() : '';
  return text || DEGRADED_REPLY.text;
}
