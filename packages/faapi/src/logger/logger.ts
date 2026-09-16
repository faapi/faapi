import type {
  LogConfig,
  LogEntry,
  LogLevel,
  LogSink,
  Logger,
  CreateLoggerOptions,
} from './loggerTypes';
import { formatEntry } from './formatEntry';
import { createFileLogSink, type FileLogSinkHandle } from './fileSink';

/**
 * 框架级结构化日志器（logger.md）——参考 egg.js 的单管道模型
 *
 * 一条日志管道、两个输出出口，各有独立阈值：
 * - 管道出口（文件 `dir` / 自定义 `sink`）：`level` 阈值，不配不过滤（全量条目，
 *   分流由文件布局或下游 sink 决定）
 * - console 出口：`consoleLevel` 阈值，不配 `'info'`（`false` 关闭 console）
 *
 * 请求日志（middleware/logger.ts）无条件并入管道（`accessLog: false` 关闭），
 * `config.logger` 独立配置已废除——单一 `config.log` 入口管全部输出。
 *
 * 全局配置为进程级资源（stdout/文件本就进程唯一），由 `configureLogging` 设置
 * （createAppBase 启动时读 config.log 调用），多 app 同进程后启动覆盖先启动。
 *
 * 日志调用永不抛错：fields 序列化失败降级为提示文本（fallback.md）。
 */

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const VALID_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

function assertLogLevel(value: unknown, source: string): asserts value is LogLevel {
  if (typeof value !== 'string' || !VALID_LEVELS.includes(value as LogLevel)) {
    throw new Error(
      `[faapi] Invalid log level from ${source}: ${String(value)}. Expected one of: ${VALID_LEVELS.join(', ')}.`,
    );
  }
}

/**
 * 全局日志配置（进程级）
 *
 * level 为 null 表示未配置——管道出口不过滤（全量条目进文件/sink）。
 * consoleLevel 为 null 表示未配置——console 出口默认 'info'；false 关闭 console。
 * sink/fileSink 互斥（configureLogging 校验）。disabled 对应 `config.log: false`
 * （管道与请求日志全部静默）。
 */
const globalState: {
  level: LogLevel | null;
  consoleLevel: LogLevel | false | null;
  sink: LogSink | null;
  fileSink: FileLogSinkHandle | null;
  stdout: boolean;
  accessLog: boolean;
  disabled: boolean;
} = {
  level: null,
  consoleLevel: null,
  sink: null,
  fileSink: null,
  stdout: true,
  accessLog: true,
  disabled: false,
};

/**
 * 设置全局日志配置（进程级，`createAppBase` 启动时以 `config.log` 调用）
 *
 * - `false`：全部静默（含 error 与请求日志，测试降噪场景）
 * - `true` / `{}`：console 出口默认 info，管道出口不过滤，无文件输出
 * - `{ level, consoleLevel, sink, dir, stdout, accessLog }`：egg 模型精细配置
 *   （level 管管道出口、consoleLevel 管 console 出口；sink 与 dir 互斥）
 * - `undefined`：重置为默认（编程式多 app 切换全局配置用）
 *
 * LOG_LEVEL env 仅作为管道 level 的环境来源（consoleLevel 无 env）——本函数是
 * env 读取点，非法值启动期报错（fail fast）。
 */
export function configureLogging(config?: LogConfig | boolean | undefined): void {
  const objectConfig = typeof config === 'object' ? config : {};
  if (objectConfig.sink && objectConfig.dir) {
    throw new Error(
      '[faapi] config.log.sink and config.log.dir are mutually exclusive: pick one output pipeline (custom sink OR built-in file logs).',
    );
  }
  // 旧文件流先关（切配置/重置不泄漏 fd；close 异步收尾，不影响新配置立即生效）
  void globalState.fileSink?.close();

  globalState.disabled = config === false;
  globalState.sink = objectConfig.sink ?? null;
  globalState.accessLog = objectConfig.accessLog ?? true;
  globalState.stdout = objectConfig.stdout ?? true;
  globalState.fileSink = objectConfig.dir
    ? createFileLogSink({ dir: objectConfig.dir, splitByLevel: objectConfig.splitByLevel })
    : null;
  if (objectConfig.consoleLevel !== undefined) {
    if (objectConfig.consoleLevel !== false) {
      assertLogLevel(objectConfig.consoleLevel, 'config.log.consoleLevel');
    }
    globalState.consoleLevel = objectConfig.consoleLevel;
  } else {
    globalState.consoleLevel = null;
  }
  if (objectConfig.level !== undefined) {
    assertLogLevel(objectConfig.level, 'config.log.level');
    globalState.level = objectConfig.level;
  } else if (process.env.LOG_LEVEL !== undefined) {
    assertLogLevel(process.env.LOG_LEVEL, 'LOG_LEVEL env');
    globalState.level = process.env.LOG_LEVEL as LogLevel;
  } else {
    globalState.level = null;
  }
}

/**
 * 管道阈值（文件/sink 收到的条目）；undefined = 不过滤（未配置 level 时全量放行，
 * 分流由文件布局或下游 sink 决定）
 */
function pipelineThreshold(): LogLevel | undefined {
  return globalState.level ?? undefined;
}

/** console 出口阈值；false = console 关闭 */
function consoleThreshold(): LogLevel | false {
  return globalState.consoleLevel ?? 'info';
}

/** 阈值判定（threshold undefined = 不过滤） */
function belowThreshold(level: LogLevel, threshold: LogLevel | undefined): boolean {
  return threshold !== undefined && LEVEL_RANK[level] < LEVEL_RANK[threshold];
}

/**
 * 当前生效的管道级别（任务隔离派发用：级别随 workerData 下发做 worker 侧预过滤，
 * 宿主侧 writeLogEntry 再次过滤——两级一致，派发后级别变更以宿主为准；
 * undefined = 不过滤，worker 侧同样放行全量）
 */
export function getEffectiveLogLevel(): LogLevel | undefined {
  return pipelineThreshold();
}

const CONSOLE_METHOD: Record<LogLevel, 'debug' | 'info' | 'warn' | 'error'> = {
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  error: 'error',
};

/** console 输出（对应级别方法，warn/error 走 stderr），受 consoleLevel 阈值过滤 */
function consoleDispatch(entry: LogEntry): void {
  const threshold = consoleThreshold();
  if (threshold === false || belowThreshold(entry.level, threshold)) return;
  console[CONSOLE_METHOD[entry.level]](formatEntry(entry));
}

/**
 * 全局管道：disabled 检查 + 出口解析（各出口独立阈值——egg transport 模型）
 *
 * 优先级：全局 sink（显式接管，受 `level`，不经 console）→ 文件管道（`dir`，
 * 受 `level`；stdout 非 false 时 console 双写，受 `consoleLevel`）→ 纯 console
 * （受 `consoleLevel`）。`level` 与 `consoleLevel` 互不牵扯：文件可只存 error
 * 而.console 看全部。
 */
function globalDispatch(entry: LogEntry): void {
  if (globalState.disabled) return;
  const pipeThreshold = pipelineThreshold();
  if (globalState.sink) {
    if (!belowThreshold(entry.level, pipeThreshold)) globalState.sink(entry);
    return;
  }
  if (globalState.fileSink) {
    if (!belowThreshold(entry.level, pipeThreshold)) globalState.fileSink.write(entry);
    if (globalState.stdout) consoleDispatch(entry);
    return;
  }
  consoleDispatch(entry);
}

/**
 * 写一条预构建的日志条目（直达全局管道，各出口按自身阈值过滤）
 *
 * 任务隔离执行桥接用：worker 内联日志器把条目作为纯数据 postMessage 回传宿主，
 * 宿主侧经本函数走统一管道（自定义 sink / 文件管道同样覆盖隔离任务）。
 */
export function writeLogEntry(entry: LogEntry): void {
  globalDispatch(entry);
}

/**
 * 刷盘文件日志缓冲（不结束流，flush 后可继续写）
 *
 * 优雅停机场景在 `lifecycle.onClose` 调用，确保缓冲中的条目落盘后再退出进程；
 * 测试场景断言文件内容前调用。无文件管道（未配置 `config.log.dir`）时为 no-op。
 */
export function flushLogging(): Promise<void> {
  return globalState.fileSink ? globalState.fileSink.flush() : Promise.resolve();
}

/**
 * 请求日志是否并入管道（middleware/logger.ts 默认输出决策用）
 *
 * 缺省并入（egg 模型：访问日志与业务日志同管道）；`config.log.accessLog: false`
 * 或 `config.log: false` 时请求日志不输出。
 */
export function isAccessLogEnabled(): boolean {
  return !globalState.disabled && globalState.accessLog;
}

/**
 * 创建日志器
 *
 * @param scope 分类标签（如 'db'、'http'），默认无分类
 * @param options 实例级覆盖（level/sink/构造 fields）
 */
export function createLogger(scope?: string, options?: CreateLoggerOptions): Logger {
  const baseScope = scope;
  const baseFields = options?.fields;

  const write = (
    level: LogLevel,
    message: string,
    callFields: Record<string, unknown> | undefined,
    scopeSuffix: string | undefined,
  ): void => {
    // 实例级 level 是该 logger 的出口阈值；全局阈值在各出口独立判定（egg transport 模型）
    if (belowThreshold(level, options?.level)) return;
    const entry: LogEntry = {
      level,
      message,
      time: new Date().toISOString(),
    };
    const fullScope =
      scopeSuffix === undefined
        ? baseScope
        : baseScope === undefined
          ? scopeSuffix
          : `${baseScope}:${scopeSuffix}`;
    if (fullScope !== undefined) entry.scope = fullScope;
    if (baseFields !== undefined || callFields !== undefined) {
      entry.fields = { ...baseFields, ...callFields };
    }
    if (options?.sink) {
      // 实例级 sink：显式接管输出管道，不受全局 disabled / consoleLevel 影响
      options.sink(entry);
    } else {
      globalDispatch(entry);
    }
  };

  const makeLogger = (scopeSuffix: string | undefined): Logger => ({
    debug: (message, fields) => write('debug', message, fields, scopeSuffix),
    info: (message, fields) => write('info', message, fields, scopeSuffix),
    warn: (message, fields) => write('warn', message, fields, scopeSuffix),
    error: (message, fields) => write('error', message, fields, scopeSuffix),
    child: (childScope) =>
      makeLogger(scopeSuffix === undefined ? childScope : `${scopeSuffix}:${childScope}`),
  });

  return makeLogger(undefined);
}
