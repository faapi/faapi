import { describe, it, expect } from 'vitest';
import { createProvider, type LLMProvider } from './provider';

describe('createProvider', () => {
  it("provider='openai' 返回 LLMProvider 实例(含 complete + stream 方法)", () => {
    const provider = createProvider({
      provider: 'openai',
      apiKey: 'sk-test',
      model: 'gpt-4o',
    });
    expect(provider).toBeDefined();
    expect(typeof provider.complete).toBe('function');
    expect(typeof provider.stream).toBe('function');
  });

  it("provider='openai' 返回的对象满足 LLMProvider 接口", () => {
    const provider: LLMProvider = createProvider({
      provider: 'openai',
      apiKey: 'sk-test',
    });
    // 接口契约:complete 与 stream 都是函数
    expect(provider.complete).toBeInstanceOf(Function);
    expect(provider.stream).toBeInstanceOf(Function);
  });

  it("provider='anthropic' 抛 Unsupported LLM provider(不静默降级)", () => {
    expect(() =>
      createProvider({
        provider: 'anthropic',
        apiKey: 'sk-test',
      }),
    ).toThrowError(/Unsupported LLM provider: anthropic/);
  });

  it("provider='' 抛 Unsupported LLM provider", () => {
    expect(() =>
      createProvider({
        provider: '',
        apiKey: 'sk-test',
      }),
    ).toThrowError(/Unsupported LLM provider/);
  });

  it('provider 未设置(undefined)抛错', () => {
    expect(() =>
      // 故意省略 provider,触发不支持的 provider 路径
      createProvider({ apiKey: 'sk-test' } as never),
    ).toThrowError(/Unsupported LLM provider/);
  });

  it('不同 apiKey 实例互不影响(每次调用返回独立 provider)', () => {
    const a = createProvider({ provider: 'openai', apiKey: 'sk-a' });
    const b = createProvider({ provider: 'openai', apiKey: 'sk-b' });
    expect(a).not.toBe(b);
    // 两个 provider 都满足接口
    expect(typeof a.complete).toBe('function');
    expect(typeof b.complete).toBe('function');
  });
});
