import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logger } from './logger';
import { invokeHandler } from '../runtime/invokeHandler';
import { createTestContext } from '../runtime/createContext';
import { configureLogging, flushLogging } from '../logger/logger';
import type { LogEntry } from '../logger/loggerTypes';
import type { FaapiMiddleware } from './middlewareTypes';

describe('logger middleware', () => {
  const makeCtx = (method = 'GET', path = '/api/test') => createTestContext({ method, path });

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

describe('logger middleware 与统一日志管道（config.log.accessLog）', () => {
  const makeCtx = (method = 'GET', path = '/api/test') => createTestContext({ method, path });

  it('config.log.accessLog: true（sink 模式）时默认 logger 请求条目并入统一管道，level 按 status 映射', async () => {
    delete process.env.LOG_LEVEL;
    const entries: LogEntry[] = [];
    configureLogging({ sink: (e) => entries.push(e), accessLog: true });
    try {
      const mw = logger();
      const handler = () => new Response(null, { status: 404 });
      await invokeHandler(handler, makeCtx('GET', '/api/missing'), undefined, [mw]);
      expect(entries).toHaveLength(1);
      expect(entries[0].level).toBe('warn');
      expect(entries[0].scope).toBe('access');
      expect(entries[0].message).toMatch(/^GET \/api\/missing 404 \d+ms$/);
      expect(entries[0].fields).toMatchObject({
        requestId: expect.any(String),
        method: 'GET',
        path: '/api/missing',
        status: 404,
      });
    } finally {
      configureLogging(undefined);
      delete process.env.LOG_LEVEL;
    }
  });

  it('sink 模式缺省 accessLog 时不并入：请求日志走 console.log（行为不变）', async () => {
    delete process.env.LOG_LEVEL;
    const entries: LogEntry[] = [];
    const consoleLogs: unknown[] = [];
    configureLogging({ sink: (e) => entries.push(e) });
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      consoleLogs.push(...args);
    });
    try {
      const mw = logger();
      await invokeHandler(() => ({ ok: true }), makeCtx(), undefined, [mw]);
      expect(entries).toHaveLength(0);
      expect(consoleLogs).toHaveLength(1);
    } finally {
      vi.restoreAllMocks();
      configureLogging(undefined);
      delete process.env.LOG_LEVEL;
    }
  });

  it('dir 模式（accessLog 缺省）请求日志写入文件（scope access），与业务日志同文件', async () => {
    delete process.env.LOG_LEVEL;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faapi-access-'));
    configureLogging({ dir, stdout: false });
    try {
      const mw = logger();
      await invokeHandler(() => ({ ok: true }), makeCtx('POST', '/api/users'), undefined, [mw]);
      await flushLogging();
      const content = fs.readFileSync(path.join(dir, 'app.log'), 'utf8');
      expect(content).toMatch(/INFO \[access\] POST \/api\/users 200 \d+ms/);
    } finally {
      configureLogging(undefined);
      delete process.env.LOG_LEVEL;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('dir 模式 5xx 请求日志按 status 映射 error 级别，dup 进 error.log', async () => {
    delete process.env.LOG_LEVEL;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faapi-access-'));
    configureLogging({ dir, stdout: false });
    try {
      const mw = logger();
      const handler = () => {
        throw new Error('boom');
      };
      await expect(
        invokeHandler(handler, makeCtx('POST', '/api/broken'), undefined, [mw]),
      ).rejects.toThrow('boom');
      await flushLogging();
      const content = fs.readFileSync(path.join(dir, 'error.log'), 'utf8');
      expect(content).toMatch(/ERROR \[access\] POST \/api\/broken 500 \d+ms - boom/);
    } finally {
      configureLogging(undefined);
      delete process.env.LOG_LEVEL;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('dir 模式显式 accessLog: false 时请求日志回落 console.log，不写文件', async () => {
    delete process.env.LOG_LEVEL;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faapi-access-'));
    const consoleLogs: unknown[] = [];
    configureLogging({ dir, stdout: false, accessLog: false });
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      consoleLogs.push(...args);
    });
    try {
      const mw = logger();
      await invokeHandler(() => ({ ok: true }), makeCtx(), undefined, [mw]);
      await flushLogging();
      const content = fs.existsSync(path.join(dir, 'app.log'))
        ? fs.readFileSync(path.join(dir, 'app.log'), 'utf8')
        : '';
      expect(content).not.toContain('[access]');
      expect(consoleLogs).toHaveLength(1);
    } finally {
      vi.restoreAllMocks();
      configureLogging(undefined);
      delete process.env.LOG_LEVEL;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('config.log: false（业务全静默）时请求日志仍走 console.log（存量行为）', async () => {
    delete process.env.LOG_LEVEL;
    const consoleLogs: unknown[] = [];
    configureLogging(false);
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      consoleLogs.push(...args);
    });
    try {
      const mw = logger();
      await invokeHandler(() => ({ ok: true }), makeCtx(), undefined, [mw]);
      expect(consoleLogs).toHaveLength(1);
    } finally {
      vi.restoreAllMocks();
      configureLogging(undefined);
      delete process.env.LOG_LEVEL;
    }
  });

  it('显式 options.log 优先于统一管道（用户接管不再并入）', async () => {
    delete process.env.LOG_LEVEL;
    const entries: LogEntry[] = [];
    const custom: string[] = [];
    configureLogging({ sink: (e) => entries.push(e), accessLog: true });
    try {
      const mw = logger({ log: (_obj, msg) => custom.push(msg ?? '') });
      await invokeHandler(() => ({ ok: true }), makeCtx(), undefined, [mw]);
      expect(custom).toHaveLength(1);
      expect(entries).toHaveLength(0);
    } finally {
      configureLogging(undefined);
      delete process.env.LOG_LEVEL;
    }
  });
});
