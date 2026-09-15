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
 * 框架级结构化日志器（logger.md）
 *
 * 级别阈值 + scope 分类 + 结构化字段 + 可插拔 sink + 内置文件管道，零依赖：
 * 默认输出 console 文本，`config.log.sink` 可整体接管（接 pino/winston/文件），
 * `config.log.dir` 启用 egg 风格文件输出（含请求日志并入）。全局配置为进程级
 * 资源（stdout/文件本就进程唯一），由 `configureLogging` 设置（createAppBase
 * 启动时读 config.log 调用），多 app 同进程后启动覆盖先启动。
 *
 * 阈值解析：显式 level（config.log.level > LOG_LEVEL env）生效；未显式配置时
 * `dir` 文件模式不过滤（全量落盘，分流由 splitByLevel 文件布局承担），其余模式
 * 默认 info（既有行为）。
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
 * level 为 null 表示未显式配置——阈值回落模式默认（`dir` 文件模式不过滤、其余
 * info，见 globalThreshold）。sink/fileSink 互斥（configureLogging 校验）：
 * sink 显式接管时 fileSink 不参与。disabled 对应 `config.log: false`（业务日志
 * 全部静默，含 error；请求日志开关独立，见 middleware/logger.ts）。
 */
const globalState: {
  level: LogLevel | null;
  sink: LogSink | null;
  fileSink: FileLogSinkHandle | null;
  stdout: boolean;
  accessLog: boolean;
  disabled: boolean;
} = { level: null, sink: null, fileSink: null, stdout: true, accessLog: false, disabled: false };

/**
 * 设置全局日志配置（进程级，`createAppBase` 启动时以 `config.log` 调用）
 *
 * - `false`：完全静默（含 error，测试降噪场景）
 * - `true` / `{}`：默认级别（显式 level > LOG_LEVEL env > 模式默认）+ 默认 console sink
 * - `{ level, sink }`：自定义管道接管（与 dir 互斥，同时配置抛错）
 * - `{ dir, splitByLevel?, stdout?, accessLog? }`：egg 风格文件输出（fileSink.md）
 * - `undefined`：重置为默认（编程式多 app 切换全局配置用）
 *
 * LOG_LEVEL env 仅在本函数读取——app 启动路径必经此处（env 非法在启动期报错）；
 * 纯编程式不调本函数时 env 不生效。
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
  globalState.accessLog = objectConfig.accessLog ?? objectConfig.dir !== undefined;
  globalState.stdout = objectConfig.stdout ?? true;
  globalState.fileSink = objectConfig.dir
    ? createFileLogSink({ dir: objectConfig.dir, splitByLevel: objectConfig.splitByLevel })
    : null;
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
 * 当前生效的全局阈值；undefined 表示不过滤（dir 文件模式未显式配置 level 时，
 * 全量条目进管道——分流由文件布局/下游 sink 决定）
 */
function globalThreshold(): LogLevel | undefined {
  if (globalState.level) return globalState.level;
  if (globalState.fileSink) return undefined;
  return 'info';
}

/** 阈值判定（threshold undefined = 不过滤） */
function belowThreshold(level: LogLevel, threshold: LogLevel | undefined): boolean {
  return threshold !== undefined && LEVEL_RANK[level] < LEVEL_RANK[threshold];
}

/**
 * 当前生效的全局级别（任务隔离派发用：级别随 workerData 下发做 worker 侧预过滤，
 * 宿主侧 writeLogEntry 再次过滤——两级一致，派发后级别变更以宿主为准；
 * undefined = 不过滤，worker 侧同样放行全量）
 */
export function getEffectiveLogLevel(): LogLevel | undefined {
  return globalThreshold();
}

/** 默认输出：console 对应级别方法（warn/error 走 stderr） */
const consoleSink: LogSink = (entry) => {
  console[CONSOLE_METHOD[entry.level]](formatEntry(entry));
};

const CONSOLE_METHOD: Record<LogLevel, 'debug' | 'info' | 'warn' | 'error'> = {
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  error: 'error',
};

/**
 * 全局管道：disabled 检查 + 输出解析
 *
 * 优先级：全局 sink（显式接管）→ 文件管道（dir 配置，stdout 非 false 时 console
 * 双写）→ 默认 console。
 */
function globalDispatch(entry: LogEntry): void {
  if (globalState.disabled) return;
  if (globalState.sink) {
    globalState.sink(entry);
    return;
  }
  if (globalState.fileSink) {
    globalState.fileSink.write(entry);
    if (globalState.stdout) consoleSink(entry);
    return;
  }
  consoleSink(entry);
}

/**
 * 写一条预构建的日志条目（过全局阈值 + 全局管道）
 *
 * 任务隔离执行桥接用：worker 内联日志器把条目作为纯数据 postMessage 回传宿主，
 * 宿主侧经本函数走统一管道（自定义 sink / 文件管道同样覆盖隔离任务）。
 */
export function writeLogEntry(entry: LogEntry): void {
  if (belowThreshold(entry.level, globalThreshold())) return;
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
 * 请求日志是否并入统一日志管道（middleware/logger.ts 默认输出决策用）
 *
 * `config.log.accessLog` 显式配置优先；缺省随 `config.log.dir` 启用（文件模式下
 * 请求日志与业务日志同管道，一份配置管全部输出）。`config.log: false`（业务日志
 * 全静默）不吞请求日志——关闭请求日志用 `config.logger: false`。
 */
export function isAccessLogPiped(): boolean {
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
    const threshold = options?.level ?? globalThreshold();
    if (belowThreshold(level, threshold)) return;
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
      // 实例级 sink：显式接管输出管道，不受全局 disabled 影响
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
