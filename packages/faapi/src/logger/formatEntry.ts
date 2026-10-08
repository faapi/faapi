import { stringifyJson } from '../utils/stringifyJson';
import type { LogEntry } from './loggerTypes';

/**
 * 默认文本格式化（logger.md）：`[ISO] LEVEL [scope] message fields-JSON`
 *
 * console sink 与文件 sink（fileSink.ts）共用同一格式——同一条日志在控制台与
 * 文件中内容一致，采集侧无需区分来源。独立成模块避免 fileSink ← logger 的
 * 循环依赖（logger.ts 编排 fileSink，fileSink 只依赖格式化）。
 */

/** fields 值序列化：Error 实例展开为 { name, message, stack }（pino err serializer 惯例），其余原样交给 stringifyJson */
function serializeFieldValue(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

/**
 * 默认文本格式：[ISO] LEVEL [scope] message fields-JSON
 *
 * fields 序列化走框架统一出口 stringifyJson：Date → 毫秒时间戳、BigInt → 字符串、
 * Map/Set → 数组、NaN/±Infinity → 字符串、RegExp → 字符串——原生 JSON.stringify
 * 会抛错（BigInt）或静默丢数据（Map/Set/RegExp/NaN）的类型在此全部正确输出。
 * 循环引用等结构错误抛 TypeError 冒泡，不降级——「日志调用永不抛错」契约已废除，
 * 坏 fields 属业务数据缺陷，与全框架 JSON 序列化契约同口径显式失败。
 */
export function formatEntry(entry: LogEntry): string {
  let line = `[${entry.time}] ${entry.level.toUpperCase()} `;
  if (entry.scope) line += `[${entry.scope}] `;
  line += entry.message;
  if (entry.fields !== undefined) {
    const plain = Object.fromEntries(
      Object.entries(entry.fields).map(([k, v]) => [k, serializeFieldValue(v)]),
    );
    line += ` ${stringifyJson(plain)}`;
  }
  return line;
}
