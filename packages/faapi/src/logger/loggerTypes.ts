/**
 * 日志子系统类型契约（logger.md）
 *
 * Logger 跨越 handler（ctx.log / 参数 log）、任务（taskCtx.log）与任意业务代码
 * （createLogger）多条路径，类型是各路径形状一致的单一来源；
 * LogEntry 为纯数据（可结构化克隆），是隔离任务日志跨线程回传的契约。
 */

/** 日志级别（阈值序：debug < info < warn < error） */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * 单条日志（sink 的输入，纯数据可结构化克隆）
 *
 * time 为 ISO 字符串（写入时刻生成）；scope/fields 可省略。
 */
export interface LogEntry {
  level: LogLevel;
  message: string;
  time: string;
  scope?: string;
  fields?: Record<string, unknown>;
}

/**
 * 日志输出目标（默认 console 文本，可整体接管接 pino/winston/文件）
 *
 * sink 内抛错会被吞掉（日志永不影响业务流程）。
 */
export type LogSink = (entry: LogEntry) => void;

/**
 * 日志器接口
 *
 * 方法签名统一为 `message` 在前、结构化字段可选在后；
 * `child(scope)` 返回新 Logger（scope 以 `:` 合并、fields 浅合并，父子互不影响）。
 */
export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

/**
 * 日志器构造选项（实例级覆盖全局）
 *
 * 命名带 CreateLogger 前缀：公开导出避免与请求日志中间件的 `LoggerOptions`
 * （middleware/logger.ts，先于本模块存在）冲突。
 */
export interface CreateLoggerOptions {
  /** 实例级级别（覆盖全局 level） */
  level?: LogLevel;
  /** 实例级 sink（覆盖全局 sink；显式接管不受全局 `log: false` 影响） */
  sink?: LogSink;
  /** 构造字段（随每条日志携带，调用处 fields 同名键覆盖） */
  fields?: Record<string, unknown>;
}

/**
 * `config.log` 的对象形状（config 侧另接受 boolean：false 全静默、true 默认）
 *
 * level 解析顺序：显式值 > `LOG_LEVEL` 环境变量 > `'info'`（非法值启动报错）。
 */
export interface LogConfig {
  level?: LogLevel;
  sink?: LogSink;
}
