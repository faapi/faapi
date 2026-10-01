/**
 * Writer agent — 撰写内容（声明式 agent，config 人设 + 默认 reactLoop）
 *
 * 作为 researcher 的 sub-agent 被调用（config.agents 引用）。声明式 agent 统一走
 * reactLoop——需要确定性输出（不经 LLM）的子任务注册 tool。
 */

export const config = {
  systemPrompt: '你是一个写作助手。根据交接单主题直接输出一段简短草稿。',
};
