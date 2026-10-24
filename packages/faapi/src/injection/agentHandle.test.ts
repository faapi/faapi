import { describe, it, expect, beforeEach } from 'vitest';
import { registerAgentHandleFactory, getAgentHandle, clearAgentHandleFactory } from './agentHandle';
import type { AgentToolContext } from '../runtime/agentToolContext';
import { createTestContext } from '../testing';

describe('agentHandle', () => {
  beforeEach(() => {
    clearAgentHandleFactory();
  });

  describe('getAgentHandle — 未注册时', () => {
    it('返回 undefined', () => {
      const ctx = createTestContext({ path: '/api/test' });
      expect(getAgentHandle(ctx)).toBeUndefined();
    });
  });

  describe('registerAgentHandleFactory', () => {
    it('注册后 getAgentHandle 返回工厂产物', () => {
      const handle = { run: async () => 'result' };
      registerAgentHandleFactory(() => handle);

      const ctx = createTestContext({ path: '/api/test' });
      expect(getAgentHandle(ctx)).toBe(handle);
    });

    it('工厂接收 AgentToolContext 契约（tasks/log/signal 恒在）', () => {
      let receivedCtx: AgentToolContext | null = null;
      registerAgentHandleFactory((ctx) => {
        receivedCtx = ctx;
        return { run: async () => 'ok' };
      });

      const ctx = createTestContext({
        path: '/api/test',
        config: { agent: { maxTurns: 10 } },
      });
      getAgentHandle(ctx);

      expect(receivedCtx).not.toBeNull();
      expect(receivedCtx!.log).toBe(ctx.log);
      expect(receivedCtx!.signal).toBe(ctx.signal);
      // 轻量测试 ctx 无队列——tasks 为抛错桩，字段恒在（契约必有）
      expect(receivedCtx!.tasks).toBeDefined();
    });

    it('工厂返回 undefined 时,getAgentHandle 返回 undefined', () => {
      registerAgentHandleFactory(() => undefined);

      const ctx = createTestContext({ path: '/api/test' });
      expect(getAgentHandle(ctx)).toBeUndefined();
    });
  });

  describe('registerAgentHandleFactory — 覆盖', () => {
    it('二次注册覆盖第一次', () => {
      const handle1 = { run: async () => 'first' };
      const handle2 = { run: async () => 'second' };

      registerAgentHandleFactory(() => handle1);
      const ctx = createTestContext({ path: '/api/test' });
      expect(getAgentHandle(ctx)).toBe(handle1);

      registerAgentHandleFactory(() => handle2);
      expect(getAgentHandle(ctx)).toBe(handle2);
    });

    it('传入 null 等效于 clear', () => {
      const handle = { run: async () => 'result' };
      registerAgentHandleFactory(() => handle);

      const ctx = createTestContext({ path: '/api/test' });
      expect(getAgentHandle(ctx)).toBe(handle);

      registerAgentHandleFactory(null);
      expect(getAgentHandle(ctx)).toBeUndefined();
    });
  });

  describe('clearAgentHandleFactory', () => {
    it('清理后 getAgentHandle 返回 undefined', () => {
      const handle = { run: async () => 'result' };
      registerAgentHandleFactory(() => handle);

      const ctx = createTestContext({ path: '/api/test' });
      expect(getAgentHandle(ctx)).toBe(handle);

      clearAgentHandleFactory();
      expect(getAgentHandle(ctx)).toBeUndefined();
    });
  });

  describe('FaapiContext 透传', () => {
    it('工厂收到的 ctx 透传全量请求字段（契约超集：path / method 可读）', () => {
      let receivedCtx: AgentToolContext | null = null;
      registerAgentHandleFactory((ctx) => {
        receivedCtx = ctx;
        return undefined;
      });

      const ctx = createTestContext({
        method: 'POST',
        path: '/api/agent',
        config: { db: { host: 'localhost' } },
      });
      getAgentHandle(ctx);

      expect(receivedCtx).not.toBeNull();
      // toAgentToolContext 展开透传 ctx 全量字段（契约超集）——HTTP 绑定字段随行
      const received = receivedCtx as unknown as Record<string, unknown>;
      expect(received['path']).toBe('/api/agent');
      expect(received['method']).toBe('POST');
    });
  });
});
