import { describe, it, expect } from 'vitest';
import { createAppRegistries } from './registries';
import type { LlmComplete } from './llmTypes';

/**
 * LlmChannelStore（轻量补全通道 store）行为定义
 *
 * 与 AgentHandleStore 同形态（app 实例级、register/get/clear），
 * 差异：channel 与请求上下文无关——存实例本身，不存工厂。
 */
describe('LlmChannelStore（AppRegistries.llm）', () => {
  it('未注册时 get 返回 undefined', () => {
    const registries = createAppRegistries();
    expect(registries.llm.get()).toBeUndefined();
  });

  it('register 后 get 返回同一 channel 实例（二次注册覆盖）', () => {
    const registries = createAppRegistries();
    const channel1 = { complete: async () => 'a' } as LlmComplete;
    const channel2 = { complete: async () => 'b' } as LlmComplete;
    registries.llm.register(channel1);
    expect(registries.llm.get()).toBe(channel1);
    registries.llm.register(channel2);
    expect(registries.llm.get()).toBe(channel2);
  });

  it('register(null) 清理，get 回到 undefined', () => {
    const registries = createAppRegistries();
    registries.llm.register({ complete: async () => 'a' } as LlmComplete);
    registries.llm.register(null);
    expect(registries.llm.get()).toBeUndefined();
  });

  it('clear() 清理实例', () => {
    const registries = createAppRegistries();
    registries.llm.register({ complete: async () => 'a' } as LlmComplete);
    registries.llm.clear();
    expect(registries.llm.get()).toBeUndefined();
  });
});
