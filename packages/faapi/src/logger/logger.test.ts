import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createLogger,
  configureLogging,
  flushLogging,
  getEffectiveLogLevel,
  writeLogEntry,
} from './logger';
import { resolveInjection } from '../injection/resolveInjection';
import { injectParamsAsync } from '../injection/injectParams';
import { createTestContext } from '../runtime/createContext';
import type { LogEntry, LogSink } from './loggerTypes';

/** 捕获默认 console sink 输出的文本行 */
function spyConsole(): string[] {
  const lines: string[] = [];
  for (const method of ['debug', 'info', 'warn', 'error'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
  }
  return lines;
}

describe('logger 默认 console sink', () => {
  let lines: string[];
  beforeEach(() => {
    delete process.env.LOG_LEVEL;
    configureLogging(undefined);
    lines = spyConsole();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.LOG_LEVEL;
    configureLogging(undefined);
  });

  it('info 走 console.info，格式 [ISO] LEVEL message（无 scope 无 fields 时省略对应段）', () => {
    createLogger().info('hello');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] INFO hello$/);
  });

  it('带 scope 输出 [scope] 段', () => {
    createLogger('db').info('connected');
    expect(lines[0]).toMatch(/ INFO \[db\] connected$/);
  });

  it('fields 以 JSON 追加在尾部', () => {
    createLogger('db').info('connected', { host: 'localhost', port: 5432 });
    expect(lines[0]).toMatch(/ INFO \[db\] connected \{"host":"localhost","port":5432\}$/);
  });

  it('debug/warn/error 分别走 console.debug/warn/error', () => {
    configureLogging({ level: 'debug' });
    const log = createLogger('app');
    log.debug('d');
    log.warn('w');
    log.error('e');
    expect(lines).toEqual([
      expect.stringMatching(/ DEBUG \[app\] d$/),
      expect.stringMatching(/ WARN \[app\] w$/),
      expect.stringMatching(/ ERROR \[app\] e$/),
    ]);
  });

  it('fields 中的 Error 值序列化为 { name, message, stack }', () => {
    const log = createLogger('job');
    log.error('failed', { error: new TypeError('boom') });
    expect(lines[0]).toContain('{"error":{"name":"TypeError","message":"boom"');
    expect(lines[0]).toContain('"stack":');
  });

  it('fields 序列化失败（循环引用）不抛错，降级为提示文本', () => {
    const log = createLogger('biz');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => log.info('with cyclic fields', { data: cyclic })).not.toThrow();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('unserializable fields');
  });

  it('无 scope 的 logger 输出不含 [scope] 段', () => {
    createLogger().warn('bare');
    expect(lines[0]).toMatch(/ WARN bare$/);
  });
});

describe('logger 级别过滤', () => {
  let lines: string[];
  beforeEach(() => {
    delete process.env.LOG_LEVEL;
    configureLogging(undefined);
    lines = spyConsole();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.LOG_LEVEL;
    configureLogging(undefined);
  });

  it('默认级别 info：debug 被过滤，info/warn/error 输出', () => {
    const log = createLogger('app');
    log.debug('hidden');
    log.info('shown');
    log.warn('shown');
    log.error('shown');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain(' INFO [app] shown');
  });

  it('configureLogging({ level }) 提高全局阈值：info 被过滤', () => {
    configureLogging({ level: 'warn' });
    const log = createLogger('app');
    log.info('hidden');
    log.warn('shown');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(' WARN');
  });

  it('configureLogging({ level: "debug" }) 降低全局阈值：debug 输出', () => {
    configureLogging({ level: 'debug' });
    createLogger('app').debug('shown');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(' DEBUG');
  });

  it('logger 实例级 level 覆盖全局（降级单实例打开 debug）', () => {
    configureLogging({ level: 'warn' });
    createLogger('noisy', { level: 'debug' }).debug('shown');
    createLogger('quiet').debug('hidden');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(' DEBUG [noisy] shown');
  });

  it('configureLogging(false) 全部静默（含 error）', () => {
    configureLogging(false);
    const log = createLogger('app');
    log.debug('x');
    log.info('x');
    log.warn('x');
    log.error('x');
    expect(lines).toHaveLength(0);
  });

  it('log: false 时显式自带 sink 的 logger 仍输出（显式接管不受全局关闭影响）', () => {
    configureLogging(false);
    const sink = vi.fn<LogSink>();
    createLogger('explicit', { sink }).info('shown');
    expect(sink).toHaveBeenCalledTimes(1);
    expect(lines).toHaveLength(0);
  });

  it('configureLogging(undefined) 重置全局配置（关闭状态恢复默认）', () => {
    configureLogging(false);
    createLogger('a').error('hidden');
    configureLogging(undefined);
    createLogger('b').error('shown');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(' ERROR [b] shown');
  });
});

describe('LOG_LEVEL 环境变量', () => {
  let lines: string[];
  beforeEach(() => {
    lines = spyConsole();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.LOG_LEVEL;
    configureLogging(undefined);
  });

  it('config.level 未显式给出时读 LOG_LEVEL env', () => {
    process.env.LOG_LEVEL = 'error';
    configureLogging(true);
    createLogger('app').info('hidden');
    createLogger('app').error('shown');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(' ERROR');
  });

  it('config.level 显式值优先于 LOG_LEVEL env', () => {
    process.env.LOG_LEVEL = 'error';
    configureLogging({ level: 'debug' });
    createLogger('app').debug('shown');
    expect(lines).toHaveLength(1);
  });

  it('非法 LOG_LEVEL env 抛错（启动期 fail fast，不静默兜底）', () => {
    process.env.LOG_LEVEL = 'verbose';
    expect(() => configureLogging(true)).toThrow(/LOG_LEVEL/);
  });

  it('非法 config.log.level 抛错', () => {
    expect(() => configureLogging({ level: 'trace' as 'debug' })).toThrow(/level/);
  });
});

describe('logger 自定义 sink', () => {
  beforeEach(() => {
    delete process.env.LOG_LEVEL;
    configureLogging(undefined);
  });
  afterEach(() => {
    delete process.env.LOG_LEVEL;
    configureLogging(undefined);
  });

  it('sink 收到完整 LogEntry（level/message/time/scope/fields）', () => {
    const entries: LogEntry[] = [];
    const log = createLogger('db', { sink: (e) => entries.push(e) });
    log.info('connected', { host: 'h1' });
    expect(entries).toHaveLength(1);
    expect(entries[0].level).toBe('info');
    expect(entries[0].message).toBe('connected');
    expect(entries[0].scope).toBe('db');
    expect(entries[0].fields).toEqual({ host: 'h1' });
    expect(entries[0].time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('实例级 sink 时级别过滤仍生效（低于阈值不调用 sink）', () => {
    const sink = vi.fn<LogSink>();
    const log = createLogger('db', { level: 'warn', sink });
    log.info('x');
    log.error('y');
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0][0].level).toBe('error');
  });

  it('全局 sink 接管无实例级 sink 的 logger 输出', () => {
    const entries: LogEntry[] = [];
    configureLogging({ sink: (e) => entries.push(e) });
    createLogger('http').warn('w');
    expect(entries).toHaveLength(1);
    expect(entries[0].scope).toBe('http');
  });

  it('实例级 sink 优先于全局 sink', () => {
    const mine: LogEntry[] = [];
    const global: LogEntry[] = [];
    configureLogging({ sink: (e) => global.push(e) });
    createLogger('db', { sink: (e) => mine.push(e) }).info('x');
    createLogger('other').info('y');
    expect(mine).toHaveLength(1);
    expect(global).toHaveLength(1);
    expect(global[0].scope).toBe('other');
  });
});

describe('logger dir 文件模式（egg 风格文件输出）', () => {
  let dir: string;
  let lines: string[];

  beforeEach(() => {
    delete process.env.LOG_LEVEL;
    configureLogging(undefined);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faapi-logger-'));
    lines = spyConsole();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.LOG_LEVEL;
    configureLogging(undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const readAppLog = async (): Promise<string[]> => {
    await flushLogging();
    return fs.readFileSync(path.join(dir, 'app.log'), 'utf8').trim().split('\n');
  };

  it('业务日志写入 app.log，stdout 双写（默认）', async () => {
    configureLogging({ dir });
    createLogger('db').info('connected');
    expect((await readAppLog())[0]).toMatch(/ INFO \[db\] connected$/);
    expect(lines).toHaveLength(1);
  });

  it('未配置 level 时不过滤：debug 也落盘（文件管道全量，分流由文件布局承担）', async () => {
    configureLogging({ dir });
    createLogger('app').debug('detail');
    expect((await readAppLog())[0]).toMatch(/ DEBUG \[app\] detail$/);
  });

  it('显式 level 在 dir 模式照常生效（info 被过滤）', () => {
    configureLogging({ dir, level: 'warn' });
    createLogger('app').info('hidden');
    expect(fs.existsSync(path.join(dir, 'app.log'))).toBe(false);
  });

  it('LOG_LEVEL env 在 dir 模式同样生效', () => {
    process.env.LOG_LEVEL = 'error';
    configureLogging({ dir });
    createLogger('app').info('hidden');
    expect(fs.existsSync(path.join(dir, 'app.log'))).toBe(false);
  });

  it('stdout: false 时纯文件输出，console 静默', async () => {
    configureLogging({ dir, stdout: false });
    createLogger('app').error('file only');
    expect((await readAppLog())[0]).toMatch(/ ERROR \[app\] file only$/);
    expect(lines).toHaveLength(0);
  });

  it('splitByLevel: true 时按级别分文件', async () => {
    configureLogging({ dir, splitByLevel: true, stdout: false });
    createLogger('app').warn('w');
    await flushLogging();
    expect(fs.readFileSync(path.join(dir, 'warn.log'), 'utf8')).toMatch(/ WARN \[app\] w/);
  });

  it('sink 与 dir 同时配置抛错（互斥，fail fast）', () => {
    expect(() => configureLogging({ dir, sink: () => {} })).toThrow(/sink.*dir|dir.*sink/);
  });

  it('configureLogging(undefined) 关闭文件流，后续输出回落 console', async () => {
    configureLogging({ dir });
    createLogger('app').info('to file');
    await flushLogging();
    configureLogging(undefined);
    createLogger('app').info('back to console');
    // 两条都进 console（dir 模式默认 stdout 双写 + 关闭后回落 console）
    expect(lines).toHaveLength(2);
    expect(fs.existsSync(path.join(dir, 'app.log'))).toBe(true);
  });

  it('getEffectiveLogLevel：dir 模式未配 level 返回 undefined（不过滤），console 模式返回 info', () => {
    configureLogging({ dir });
    expect(getEffectiveLogLevel()).toBeUndefined();
    configureLogging(undefined);
    expect(getEffectiveLogLevel()).toBe('info');
  });

  it('getEffectiveLogLevel：显式 level 优先于模式默认', () => {
    configureLogging({ dir, level: 'debug' });
    expect(getEffectiveLogLevel()).toBe('debug');
  });

  it('writeLogEntry 在 dir 模式无阈值（任务桥接条目全量落盘）', async () => {
    configureLogging({ dir, stdout: false });
    writeLogEntry({ level: 'debug', message: 'from task', time: '2026-09-16T08:00:00.000Z' });
    expect((await readAppLog())[0]).toBe('[2026-09-16T08:00:00.000Z] DEBUG from task');
  });
});

describe('logger options.fields', () => {
  beforeEach(() => {
    delete process.env.LOG_LEVEL;
    configureLogging(undefined);
  });
  afterEach(() => {
    delete process.env.LOG_LEVEL;
    configureLogging(undefined);
  });

  it('构造字段随每条日志携带（默认 sink 文本尾部 JSON）', () => {
    const lines: string[] = [];
    vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    const log = createLogger('http', { fields: { requestId: 'r-1', method: 'GET' } });
    log.info('hit');
    expect(lines[0]).toContain('{"requestId":"r-1","method":"GET"}');
  });

  it('调用处字段覆盖构造字段同名键', () => {
    const entries: LogEntry[] = [];
    const log = createLogger('http', {
      fields: { requestId: 'r-1' },
      sink: (e) => entries.push(e),
    });
    log.info('hit', { requestId: 'r-2', extra: 1 });
    expect(entries[0].fields).toEqual({ requestId: 'r-2', extra: 1 });
  });

  it('child 合并 scope（: 连接）与 fields，父 logger 不受影响', () => {
    const entries: LogEntry[] = [];
    const sink = (e: LogEntry): void => {
      entries.push(e);
    };
    const parent = createLogger('http', { fields: { requestId: 'r-1' }, sink });
    const child = parent.child('user');
    child.info('from child', { userId: 7 });
    parent.info('from parent');
    expect(entries[0].scope).toBe('http:user');
    expect(entries[0].fields).toEqual({ requestId: 'r-1', userId: 7 });
    expect(entries[1].scope).toBe('http');
    expect(entries[1].fields).toEqual({ requestId: 'r-1' });
  });

  it('child 可多层嵌套（http:user:cache）', () => {
    const entries: LogEntry[] = [];
    createLogger('http', { sink: (e) => entries.push(e) })
      .child('user')
      .child('cache')
      .info('miss');
    expect(entries[0].scope).toBe('http:user:cache');
  });

  it('child 继承实例级 level', () => {
    const lines: string[] = [];
    vi.spyOn(console, 'debug').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    configureLogging({ level: 'info' });
    createLogger('app', { level: 'debug' }).child('sub').debug('shown');
    expect(lines).toHaveLength(1);
  });
});

describe('writeLogEntry（任务桥接：宿主侧写预构建条目）', () => {
  beforeEach(() => {
    delete process.env.LOG_LEVEL;
    configureLogging(undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.LOG_LEVEL;
    configureLogging(undefined);
  });

  it('条目经全局 sink 输出（scope/fields 保持原样）', () => {
    const entries: LogEntry[] = [];
    configureLogging({ sink: (e) => entries.push(e) });
    writeLogEntry({
      level: 'info',
      message: 'from task',
      time: new Date().toISOString(),
      scope: 'task:mail',
      fields: { jobId: 'j1' },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].scope).toBe('task:mail');
    expect(entries[0].fields).toEqual({ jobId: 'j1' });
  });

  it('低于全局阈值的条目被过滤', () => {
    const entries: LogEntry[] = [];
    configureLogging({ level: 'error', sink: (e) => entries.push(e) });
    writeLogEntry({ level: 'debug', message: 'x', time: new Date().toISOString() });
    expect(entries).toHaveLength(0);
  });

  it('默认路径输出到 console（文本格式含 scope）', () => {
    const lines: string[] = [];
    vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    writeLogEntry({
      level: 'info',
      message: 'done',
      time: '2026-09-15T08:00:00.000Z',
      scope: 'task:mail',
    });
    expect(lines).toEqual(['[2026-09-15T08:00:00.000Z] INFO [task:mail] done']);
  });
});

describe('参数名 log 注入（与 ctx.log 同一实例）', () => {
  beforeEach(() => {
    delete process.env.LOG_LEVEL;
    configureLogging(undefined);
  });
  afterEach(() => {
    delete process.env.LOG_LEVEL;
    configureLogging(undefined);
  });

  it('PARAM_TYPE_MAP 将参数名 log 映射为内置注入类型', () => {
    function GET(log: unknown): unknown {
      return log;
    }
    const injections = resolveInjection(GET);
    expect(injections).toHaveLength(1);
    expect(injections[0].name).toBe('log');
    expect(injections[0].type).toBe('log');
  });

  it('injectParamsAsync 注入的 log 与 ctx.log 同一实例', async () => {
    const ctx = createTestContext({ path: '/api/user', headers: { 'x-request-id': 'r-1' } });
    function GET(log: unknown): unknown {
      return log;
    }
    const injected = await injectParamsAsync(GET as (...args: unknown[]) => unknown, ctx);
    expect(injected).toBe(ctx.log);
  });
});
