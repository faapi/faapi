import { describe, it, expect, beforeEach } from 'vitest';
import { registerAgentHandleFactory, getAgentHandle, clearAgentHandleFactory } from './agentHandle';
import type { FaapiContext } from '../runtime/contextTypes';
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

    it('工厂接收 FaapiContext,可读 ctx.config', () => {
      let receivedConfig: unknown = null;
      registerAgentHandleFactory((ctx) => {
        receivedConfig = ctx.config;
        return { run: async () => 'ok' };
      });

      const ctx = createTestContext({
        path: '/api/test',
        config: { agent: { defaultAgent: 'researcher' } },
      });
      getAgentHandle(ctx);

      expect(receivedConfig).toEqual({ agent: { defaultAgent: 'researcher' } });
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

  describe('FaapiContext 传递', () => {
    it('工厂收到的 ctx 包含 path / method / config', () => {
      let receivedCtx: FaapiContext | null = null;
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
      expect(receivedCtx!.path).toBe('/api/agent');
      expect(receivedCtx!.method).toBe('POST');
      expect((receivedCtx!.config as Record<string, unknown>).db).toEqual({
        host: 'localhost',
      });
    });
  });
});
