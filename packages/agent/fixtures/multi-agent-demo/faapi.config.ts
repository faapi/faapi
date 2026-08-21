import type { FaapiConfig } from '@faapi/faapi';

/**
 * multi-agent demo 配置
 *
 * 声明 agent 子系统配置。e2e 测试手动注册 agentHandleFactory（mock provider），
 * 不依赖 @faapi/agent 插件自动加载——真实项目应额外声明 `plugins: ['@faapi/agent']`。
 */
export default {
  agent: {
    llm: {
      provider: 'openai',
      apiKey: 'mock-key',
      model: 'gpt-4o',
    },
    defaultAgent: 'researcher',
    maxTurns: 10,
    maxAgentDepth: 3,
    defaultTools: ['weather.getWeather'],
  },
} satisfies FaapiConfig;
