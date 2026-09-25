import { isPlainObject } from './isPlainObject';

/**
 * 框架统一 JSON 序列化出口：JSON 原生类型之外的一切值转换为可逆的原生表示。
 *
 * 原生 `JSON.stringify` 对规范外类型的行为不可接受：BigInt 抛 TypeError（响应 500）、
 * Map/Set/RegExp 静默序列化为 "{}"（丢数据）、NaN/±Infinity 静默变 null（丢信息）。
 * 设计契约是「线上格式即契约」：序列化把规范外类型转成可逆的原生表示（Date → 毫秒
 * 时间戳、BigInt → 字符串、Map → entries 数组、Set → 数组），客户端按转换后类型
 * 消费或自行还原，不提供序列化之外的第二条数据通路。完整转换表见 ./stringifyJson.md。
 *
 * 实现为「预变换值树 + 原生 stringify」而非 replacer——JSON.stringify 的 replacer
 * 在 toJSON 之后运行，拦不到 Date（此时已是 ISO 字符串）。预变换规则：
 *
 * - Date（含子类）→ `getTime()` 毫秒时间戳
 * - BigInt → `toString()` 字符串
 * - Map → entries 数组、Set → 值数组（键值/元素递归转换）
 * - 非有限 number（NaN/±Infinity）→ `"NaN"` / `"±Infinity"` 字符串
 * - RegExp → `"/source/flags"` 字符串
 * - 带 toJSON 的对象 → 递归转换其返回值（与原生语义对齐，且 toJSON 结果中的
 *   Date/BigInt 也被转换）
 * - plain object / array → 递归重建（查找嵌套的特殊类型）
 * - 其他对象（类实例、URL 等）→ 原样返回，由原生 stringify 处理（保留 toJSON 语义）
 * - 循环引用 → 抛 TypeError（结构错误显式失败，不静默产出坏 JSON）；非循环的
 *   共享引用不受影响
 */
export function stringifyJson(value: unknown): string {
  // 快路径：整棵值树均为 JSON 原生类型（绝大多数响应的形态）时零分配直通原生
  // stringify。慢路径对 plain object/array 无条件递归重建——每个响应都要付出一次
  // 全量深拷贝（GC 压力翻倍）；检测本身零分配（只做类型判断），无特殊类型时省掉
  // 整棵树的重建。检测遇循环引用与慢路径同语义抛 TypeError
  if (!needsConversion(value, new Set<object>())) {
    return JSON.stringify(value);
  }
  return JSON.stringify(convertValue(value, new Set<object>()));
}

/**
 * 检测值树是否需要转换（含 Date/BigInt/Map/Set/NaN/RegExp/toJSON 时走慢路径重建）
 *
 * 与 convertValue 相同的遍历结构与循环引用检测（ancestors），但零分配——
 * 只做类型判断，不重建任何对象/数组。
 */
function needsConversion(value: unknown, ancestors: Set<object>): boolean {
  if (value === null) return false;
  const type = typeof value;
  if (type === 'bigint') return true;
  if (type === 'number') return !Number.isFinite(value as number);
  if (type !== 'object') return false;

  const obj = value as object;
  if (ancestors.has(obj)) {
    throw new TypeError('[faapi] Converting circular structure to JSON');
  }
  if (obj instanceof Date || obj instanceof Map || obj instanceof Set || obj instanceof RegExp) {
    return true;
  }
  // 带 toJSON 的对象走慢路径：其返回值中的特殊类型也要转换
  if (typeof (obj as { toJSON?: unknown }).toJSON === 'function') return true;

  if (Array.isArray(obj)) {
    ancestors.add(obj);
    for (let i = 0; i < obj.length; i++) {
      if (needsConversion(obj[i], ancestors)) {
        ancestors.delete(obj);
        return true;
      }
    }
    ancestors.delete(obj);
    return false;
  }
  if (isPlainObject(obj)) {
    ancestors.add(obj);
    // for-in + hasOwnProperty 避免分配键数组（Object.keys/entries 每节点一个数组）；
    // 可枚举性与 getters 的调用语义与 Object.entries 一致
    for (const key in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
      if (needsConversion((obj as Record<string, unknown>)[key], ancestors)) {
        ancestors.delete(obj);
        return true;
      }
    }
    ancestors.delete(obj);
    return false;
  }
  // 其他对象（类实例、URL 等）：原样序列化，无需转换
  return false;
}

/** 递归转换值树中的规范外类型（ancestors 做循环引用检测） */
function convertValue(value: unknown, ancestors: Set<object>): unknown {
  // 原始类型：bigint 转字符串，非有限 number（NaN/±Infinity）转字符串，其余原样
  if (value === null) return value;
  const type = typeof value;
  if (type === 'bigint') return (value as bigint).toString();
  if (type === 'number') return Number.isFinite(value as number) ? value : String(value);
  if (type !== 'object') return value;

  const obj = value as object;
  if (ancestors.has(obj)) {
    throw new TypeError('[faapi] Converting circular structure to JSON');
  }

  // Date（含子类）→ 毫秒时间戳。在 toJSON 检查之前：Date 自带 toJSON（ISO 字符串），
  // 契约要求时间戳形态
  if (obj instanceof Date) return obj.getTime();
  // Map → entries 数组、Set → 值数组（键值/元素递归转换，保持与输入侧 zod schema
  // 的 coerceMap/coerceSet 还原约定可逆）
  if (obj instanceof Map) {
    ancestors.add(obj);
    const entries = Array.from(obj, ([k, v]) => [
      convertValue(k, ancestors),
      convertValue(v, ancestors),
    ]);
    ancestors.delete(obj);
    return entries;
  }
  if (obj instanceof Set) {
    ancestors.add(obj);
    const values = Array.from(obj, (v) => convertValue(v, ancestors));
    ancestors.delete(obj);
    return values;
  }
  if (obj instanceof RegExp) return obj.toString();

  // 带 toJSON 的对象：递归转换其返回值（Date/BigInt 等出现在 toJSON 结果中同样被转换）
  const toJSON = (obj as { toJSON?: unknown }).toJSON;
  if (typeof toJSON === 'function') {
    ancestors.add(obj);
    const result = convertValue((toJSON as () => unknown).call(obj), ancestors);
    ancestors.delete(obj);
    return result;
  }

  // plain object / array：递归重建，查找嵌套的特殊类型
  if (Array.isArray(obj)) {
    ancestors.add(obj);
    const arr = obj.map((item) => convertValue(item, ancestors));
    ancestors.delete(obj);
    return arr;
  }
  if (isPlainObject(obj)) {
    ancestors.add(obj);
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      out[key] = convertValue(val, ancestors);
    }
    ancestors.delete(obj);
    return out;
  }

  // 其他对象（类实例、URL 等）：原样返回，由原生 stringify 处理（保留 toJSON 语义、
  // 枚举自有属性等原生行为）
  return obj;
}
