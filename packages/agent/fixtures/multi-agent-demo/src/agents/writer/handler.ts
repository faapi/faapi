/**
 * Writer agent — 撰写内容，有自定义 run 函数（不走 LLM，直接生成草稿）
 *
 * 作为 researcher 的 sub-agent 被调用。有 hasRun 时 executeSubAgent 走自定义逻辑，
 * 不触发 LLM 调用——适用于确定性子任务（如模板化生成、数据格式化）。
 */

export const config = {
  systemPrompt: '你是一个写作助手。',
};

/**
 * 自定义 run 函数
 *
 * sub-agent 调用时接收 args 对象，返回生成的内容。
 * 不走 LLM，直接返回固定草稿（demo 简化，真实场景可调 LLM）。
 */
export async function run(args: { topic?: string }): Promise<string> {
  const topic = args.topic ?? '未知主题';
  return `关于「${topic}」的草稿：这是一份由 writer agent 生成的示例报告。`;
}
