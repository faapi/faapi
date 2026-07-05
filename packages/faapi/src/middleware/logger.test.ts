import { describe, it, expect } from 'vitest';
import { logger } from './logger';
import { invokeHandler } from '../runtime/invokeHandler';
import { createContext } from '../runtime/createContext';
import type { FaapiMiddleware } from './middlewareTypes';

describe('logger middleware', () => {
  const makeCtx = (method = 'GET', path = '/api/test') =>
    createContext(new Request(`http://localhost${path}`, { method }), {});

  it('logs method, path, status, duration on successful request', async () => {
    const logs: string[] = [];
    const mw = logger({ log: (_obj, msg) => logs.push(msg ?? String(_obj)) });
    const handler = () => ({ ok: true });

    const response = await invokeHandler(handler, makeCtx('GET', '/api/users'), undefined, [mw]);
    expect(response.status).toBe(200);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^GET \/api\/users 200 \d+ms$/);
  });

  it('logs POST method correctly', async () => {
    const logs: string[] = [];
    const mw = logger({ log: (_obj, msg) => logs.push(msg ?? String(_obj)) });
    const handler = () => ({ ok: true });

    const response = await invokeHandler(handler, makeCtx('POST', '/api/items'), undefined, [mw]);
    expect(response.status).toBe(200);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^POST \/api\/items 200 \d+ms$/);
  });

  it('logs error with 500 status when handler throws (caught by inner middleware)', async () => {
    const logs: string[] = [];
    const mw = logger({ log: (_obj, msg) => logs.push(msg ?? String(_obj)) });
    const handler = () => {
      throw new Error('something broke');
    };

    // 内层错误处理中间件捕获错误，返回 500 响应
    const errorHandler: FaapiMiddleware = async (_ctx, next) => {
      try {
        await next();
      } catch (err) {
        return new Response(JSON.stringify({ error: (err as Error).message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    };

    const response = await invokeHandler(handler, makeCtx('POST', '/api/users'), undefined, [
      mw,
      errorHandler,
    ]);
    expect(response.status).toBe(500);
    // logger 在外层，错误被内层捕获返回 500，logger 从 next() 返回的 Response 拿到 500
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^POST \/api\/users 500 \d+ms$/);
  });

  it('logs error with status and message when error propagates', async () => {
    const logs: string[] = [];
    const mw = logger({ log: (_obj, msg) => logs.push(msg ?? String(_obj)) });
    const handler = () => {
      throw new Error('fail');
    };

    // logger 在外层，错误没被内层捕获，logger 记录后重新抛出
    await expect(
      invokeHandler(handler, makeCtx('PUT', '/api/items/1'), undefined, [mw]),
    ).rejects.toThrow('fail');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^PUT \/api\/items\/1 500 \d+ms - fail$/);
  });

  it('logs non-Error thrown value as string', async () => {
    const logs: string[] = [];
    const mw = logger({ log: (_obj, msg) => logs.push(msg ?? String(_obj)) });
    const handler = () => {
      throw 'string error';
    };

    await expect(
      invokeHandler(handler, makeCtx('DELETE', '/api/items/1'), undefined, [mw]),
    ).rejects.toBe('string error');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^DELETE \/api\/items\/1 500 \d+ms - string error$/);
  });

  it('uses custom log function', async () => {
    const customLogs: string[] = [];
    const mw = logger({ log: (_obj, msg) => customLogs.push(msg ?? String(_obj)) });
    const handler = () => ({ ok: true });

    await invokeHandler(handler, makeCtx(), undefined, [mw]);
    expect(customLogs).toHaveLength(1);
  });

  it('defaults to console.log when no options provided', async () => {
    const mw = logger();
    const handler = () => ({ ok: true });

    // Just verify it doesn't throw
    const response = await invokeHandler(handler, makeCtx(), undefined, [mw]);
    expect(response.status).toBe(200);
  });

  it('records duration that is >= 0', async () => {
    const logs: string[] = [];
    const mw = logger({ log: (_obj, msg) => logs.push(msg ?? String(_obj)) });
    const handler = () => ({ ok: true });

    await invokeHandler(handler, makeCtx(), undefined, [mw]);
    const match = logs[0].match(/(\d+)ms$/);
    expect(match).not.toBeNull();
    const duration = parseInt(match![1], 10);
    expect(duration).toBeGreaterThanOrEqual(0);
  });
});
