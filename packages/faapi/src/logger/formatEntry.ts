import type { LogEntry } from './loggerTypes';

/**
 * 默认文本格式化（logger.md）：`[ISO] LEVEL [scope] message fields-JSON`
 *
 * console sink 与文件 sink（fileSink.ts）共用同一格式——同一条日志在控制台与
 * 文件中内容一致，采集侧无需区分来源。独立成模块避免 fileSink ← logger 的
 * 循环依赖（logger.ts 编排 fileSink，fileSink 只依赖格式化）。
 */

/** fields 值序列化：Error 实例展开为 { name, message, stack }（pino err serializer 惯例），其余原样交给 JSON.stringify */
function serializeFieldValue(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

/** 默认文本格式：[ISO] LEVEL [scope] message fields-JSON */
export function formatEntry(entry: LogEntry): string {
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
