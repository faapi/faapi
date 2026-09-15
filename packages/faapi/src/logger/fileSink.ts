import fs from 'node:fs';
import path from 'node:path';
import { formatEntry } from './formatEntry';
import type { LogSink } from './loggerTypes';

/**
 * egg.js 风格文件日志 sink（fileSink.md）
 *
 * `config.log.dir` 配置目录即启用：默认布局 `app.log`（全量）+ `error.log`
 * （仅 error，dup 语义——一条 error 两处都有，参考 egg-logger common-error.log）；
 * `splitByLevel: true` 改为按级别四文件（各只含对应级别）。
 *
 * 写入为持久 WriteStream（flags: 'a' 追加）异步缓冲；流错误监听后吞掉——日志
 * 永不影响业务（磁盘满/权限丢失时静默停止写文件，与"日志调用永不抛错"同语义）。
 * 目录由 `configureLogging` 启动期经本模块创建，失败抛错 fail fast。
 */

const LEVEL_FILES = ['debug', 'info', 'warn', 'error'] as const;

export interface FileLogSinkOptions {
  /** 日志目录（不存在时递归创建，创建失败抛错） */
  dir: string;
  /** true：按级别四文件；false（默认）：app.log 全量 + error.log 仅 error */
  splitByLevel?: boolean;
}

export interface FileLogSinkHandle {
  /** 写入条目（close 后调用为 no-op，不抛错） */
  write: LogSink;
  /** 等待已写入条目落盘（不结束流，flush 后可继续写；无 pending 时立即 resolve） */
  flush: () => Promise<void>;
  /** 结束全部流（end 回调全部完成后 resolve；可重复调用） */
  close: () => Promise<void>;
}

/**
 * 创建文件日志 sink
 *
 * @param options.dir 日志目录；options.splitByLevel 分级文件开关
 */
export function createFileLogSink(options: FileLogSinkOptions): FileLogSinkHandle {
  fs.mkdirSync(options.dir, { recursive: true });

  const streams = new Map<string, fs.WriteStream>();

  const getStream = (name: string): fs.WriteStream | undefined => {
    if (streams.has(name)) return streams.get(name);
    // close 后再 write：流已从 Map 清除，此处重建会被下次 close 清理——但语义上
    // close 表示管道终止，直接返回 undefined 丢弃（日志永不影响业务，不抛错）
    return undefined;
  };

  const openStream = (name: string): void => {
    const stream = fs.createWriteStream(path.join(options.dir, `${name}.log`), { flags: 'a' });
    // 磁盘满/权限等写入失败：吞掉不崩进程（unhandled 'error' 事件会 terminate 进程）
    stream.on('error', () => {});
    streams.set(name, stream);
  };

  const fileNames = options.splitByLevel ? [...LEVEL_FILES] : ['app', 'error'];
  for (const name of fileNames) openStream(name);

  // pending 写入计数 + drain 等待者：flush 语义 = 已调用 write 的条目全部落盘
  let pendingCount = 0;
  let drainWaiters: (() => void)[] = [];
  const onWriteDone = (): void => {
    pendingCount--;
    if (pendingCount === 0 && drainWaiters.length > 0) {
      const waiters = drainWaiters;
      drainWaiters = [];
      for (const waiter of waiters) waiter();
    }
  };

  const write: LogSink = (entry) => {
    const line = `${formatEntry(entry)}\n`;
    const target = options.splitByLevel ? entry.level : 'app';
    const main = getStream(target);
    if (main) {
      pendingCount++;
      main.write(line, onWriteDone);
    }
    // egg dup 语义：默认布局下 error 条目额外写入 error.log
    if (!options.splitByLevel && entry.level === 'error') {
      const dup = getStream('error');
      if (dup) {
        pendingCount++;
        dup.write(line, onWriteDone);
      }
    }
  };

  const flush = (): Promise<void> =>
    new Promise<void>((resolve) => {
      if (pendingCount === 0) {
        resolve();
        return;
      }
      drainWaiters.push(resolve);
    });

  const close = (): Promise<void> =>
    Promise.all(
      [...streams.values()].map(
        (stream) =>
          new Promise<void>((resolve) => {
            stream.end(() => resolve());
          }),
      ),
    ).then(() => {
      streams.clear();
    });

  return { write, flush, close };
}
