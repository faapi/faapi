import type {
  LogConfig,
  LogEntry,
  LogLevel,
  LogSink,
  Logger,
  CreateLoggerOptions,
} from './loggerTypes';

/**
 * 框架级结构化日志器（logger.md）
 *
 * 级别阈值 + scope 分类 + 结构化字段 + 可插拔 sink，零依赖：默认输出 console 文本，
 * `config.log.sink` 可整体接管（接 pino/winston/文件）。全局配置为进程级资源
 * （stdout/文件本就进程唯一），由 `configureLogging` 设置（createAppBase 启动时
 * 读 config.log 调用），多 app 同进程后启动覆盖先启动。
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
 * level/sink 为 null 表示未配置——level 回落默认 info、sink 回落默认 console。
 * disabled 对应 `config.log: false`（全部静默，含 error）。
 */
const globalState: { level: LogLevel | null; sink: LogSink | null; disabled: boolean } = {
  level: null,
  sink: null,
  disabled: false,
};

/**
 * 设置全局日志配置（进程级，`createAppBase` 启动时以 `config.log` 调用）
 *
 * - `false`：完全静默（含 error，测试降噪场景）
 * - `true` / `{}`：默认级别（显式 level > LOG_LEVEL env > 'info'）+ 默认 console sink
 * - `{ level, sink }`：精细配置；非法 level 抛错（启动期 fail fast）
 * - `undefined`：重置为默认（编程式多 app 切换全局配置用）
 *
 * LOG_LEVEL env 仅在本函数读取——app 启动路径必经此处（env 非法在启动期报错）；
 * 纯编程式不调本函数时 env 不生效（默认 info）。
 */
export function configureLogging(config?: LogConfig | boolean | undefined): void {
  if (config === undefined) {
    globalState.level = null;
    globalState.sink = null;
    globalState.disabled = false;
    return;
  }
  const objectConfig = typeof config === 'object' ? config : {};
  globalState.disabled = config === false;
  globalState.sink = objectConfig.sink ?? null;
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

/** 当前生效的全局阈值（未配置时默认 info） */
function globalThreshold(): LogLevel {
  return globalState.level ?? 'info';
}

/**
 * 当前生效的全局级别（任务隔离派发用：级别随 workerData 下发做 worker 侧预过滤，
 * 宿主侧 writeLogEntry 再次过滤——两级一致，派发后级别变更以宿主为准）
 */
export function getEffectiveLogLevel(): LogLevel {
  return globalThreshold();
}

/**
 * fields 值序列化：Error 实例展开为 { name, message, stack }（pino err serializer 惯例），
 * 其余原样交给 JSON.stringify
 */
function serializeFieldValue(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

/** 默认 console sink 的文本格式：[ISO] LEVEL [scope] message fields-JSON */
function formatEntry(entry: LogEntry): string {
  let line = `[${entry.time}] ${entry.level.toUpperCase()} `;
  if (entry.scope) line += `[${entry.scope}] `;
  line += entry.message;
  if (entry.fields !== undefined) {
    const plain = Object.fromEntries(
      Object.entries(entry.fields).map(([k, v]) => [k, serializeFieldValue(v)]),
    );
    try {
      line += ` ${JSON.stringify(plain)}`;
    } catch (err) {
      // 循环引用等不可序列化 fields：降级为提示文本，日志调用不抛错（fallback.md）
      line += ` [unserializable fields: ${err instanceof Error ? err.message : String(err)}]`;
    }
  }
  return line;
}

const CONSOLE_METHOD: Record<LogLevel, 'debug' | 'info' | 'warn' | 'error'> = {
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  error: 'error',
};

/** 默认输出：console 对应级别方法（warn/error 走 stderr） */
const consoleSink: LogSink = (entry) => {
  console[CONSOLE_METHOD[entry.level]](formatEntry(entry));
};

/**
 * 全局管道：disabled 检查 + 全局 sink（无全局 sink 时回落默认 console）
 */
function globalDispatch(entry: LogEntry): void {
  if (globalState.disabled) return;
  (globalState.sink ?? consoleSink)(entry);
}

/**
 * 写一条预构建的日志条目（过全局阈值 + 全局管道）
 *
 * 任务隔离执行桥接用：worker 内联日志器把条目作为纯数据 postMessage 回传宿主，
 * 宿主侧经本函数走统一管道（自定义 sink 同样覆盖隔离任务）。
 */
export function writeLogEntry(entry: LogEntry): void {
  if (LEVEL_RANK[entry.level] < LEVEL_RANK[globalThreshold()]) return;
  globalDispatch(entry);
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
    if (LEVEL_RANK[level] < LEVEL_RANK[threshold]) return;
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
