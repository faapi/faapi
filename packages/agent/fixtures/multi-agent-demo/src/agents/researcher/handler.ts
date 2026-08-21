/**
 * Researcher agent — 负责研究主题，可调用 writer sub-agent 撰写内容
 *
 * config 块声明：
 * - systemPrompt：引导 LLM 作为研究助手
 * - agents：可调用 writer sub-agent
 * - tools：agent 显式声明可用的 tool 引用（weather + calculator）
 * - model / maxTurns：agent 自身配置，优先于全局 config.agent
 */

export const config = {
  systemPrompt: '你是一个研究助手，可以查询天气和进行计算，必要时调用 writer 撰写报告。',
  agents: ['writer'],
  tools: ['weather.getWeather', 'calculator.calc'],
  model: 'gpt-4o',
  maxTurns: 5,
};
