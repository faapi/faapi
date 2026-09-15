import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFileLogSink } from './fileSink';
import type { LogEntry, LogLevel } from './loggerTypes';

/** 构造测试条目（time 固定便于断言文本格式） */
function makeEntry(level: LogLevel, message: string, scope?: string): LogEntry {
  const entry: LogEntry = { level, message, time: '2026-09-16T08:00:00.000Z' };
  if (scope) entry.scope = scope;
  return entry;
}

describe('createFileLogSink', () => {
  let dir: string;

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('默认布局：app.log 全量条目 + error.log 仅 error（dup，一条 error 两处都有）', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faapi-logs-'));
    const sink = createFileLogSink({ dir });
    sink.write(makeEntry('info', 'connected', 'db'));
    sink.write(makeEntry('error', 'failed', 'db'));
    sink.write(makeEntry('debug', 'detail', 'db'));
    await sink.close();

    const appLines = fs.readFileSync(path.join(dir, 'app.log'), 'utf8').trim().split('\n');
    expect(appLines).toHaveLength(3);
    expect(appLines[0]).toBe('[2026-09-16T08:00:00.000Z] INFO [db] connected');
    expect(appLines[1]).toContain(' ERROR [db] failed');
    expect(appLines[2]).toContain(' DEBUG [db] detail');

    const errorLines = fs.readFileSync(path.join(dir, 'error.log'), 'utf8').trim().split('\n');
    expect(errorLines).toHaveLength(1);
    expect(errorLines[0]).toBe('[2026-09-16T08:00:00.000Z] ERROR [db] failed');
  });

  it('splitByLevel: true：四个级别文件各只含对应级别条目', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faapi-logs-'));
    const sink = createFileLogSink({ dir, splitByLevel: true });
    sink.write(makeEntry('debug', 'd'));
    sink.write(makeEntry('info', 'i1'));
    sink.write(makeEntry('info', 'i2'));
    sink.write(makeEntry('warn', 'w'));
    sink.write(makeEntry('error', 'e'));
    await sink.close();

    expect(fs.existsSync(path.join(dir, 'app.log'))).toBe(false);
    const read = (name: string): string[] =>
      fs.readFileSync(path.join(dir, name), 'utf8').trim().split('\n');
    expect(read('debug.log')).toEqual(['[2026-09-16T08:00:00.000Z] DEBUG d']);
    expect(read('info.log')).toHaveLength(2);
    expect(read('warn.log')).toEqual(['[2026-09-16T08:00:00.000Z] WARN w']);
    expect(read('error.log')).toEqual(['[2026-09-16T08:00:00.000Z] ERROR e']);
  });

  it('目录不存在时多级自动创建（recursive）', async () => {
    dir = path.join(os.tmpdir(), `faapi-logs-${Date.now()}`, 'a', 'b');
    const sink = createFileLogSink({ dir });
    sink.write(makeEntry('info', 'first'));
    await sink.close();
    expect(fs.readFileSync(path.join(dir, 'app.log'), 'utf8')).toContain(' INFO first');
  });

  it('目录创建失败抛错（fail fast，不静默丢日志）', () => {
    const file = path.join(os.tmpdir(), `faapi-logs-file-${Date.now()}`);
    fs.writeFileSync(file, 'not a dir');
    try {
      expect(() => createFileLogSink({ dir: path.join(file, 'sub') })).toThrow();
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it('close 后再 write 不抛错（流已结束，日志永不影响业务）', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faapi-logs-'));
    const sink = createFileLogSink({ dir });
    await sink.close();
    expect(() => sink.write(makeEntry('info', 'after close'))).not.toThrow();
  });

  it('close 可重复调用（幂等）', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faapi-logs-'));
    const sink = createFileLogSink({ dir });
    await sink.close();
    await expect(sink.close()).resolves.toBeUndefined();
  });

  it('追加模式：重复创建不覆盖已有内容', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faapi-logs-'));
    const first = createFileLogSink({ dir });
    first.write(makeEntry('info', 'one'));
    await first.close();
    const second = createFileLogSink({ dir });
    second.write(makeEntry('info', 'two'));
    await second.close();
    const lines = fs.readFileSync(path.join(dir, 'app.log'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(' one');
    expect(lines[1]).toContain(' two');
  });
});
