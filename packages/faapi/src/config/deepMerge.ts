/**
 * 深度合并两个配置对象（后者覆盖前者）
 *
 * 特殊对象（Date / RegExp / Map / Set / 函数 / 数组）直接替换，不递归合并。
 *
 * 用途：
 * - `loadConfig` 运行时合并基础配置与环境配置
 * - `compileConfig` build 时合并并生成 `dist/faapi-config.js`（通过 `DEEP_MERGE_SOURCE` 字符串内联）
 *
 * 两处必须使用同一份 `deepMerge` 实现：`compileConfig` 通过 `deepMerge.toString()`
 * 把本函数源码内联到 `faapi-config.js` 产物，确保 build 时与运行时合并逻辑完全一致。
 */
export function deepMerge<T extends Record<string, unknown>>(
  base: T,
  override: Record<string, unknown>,
): T {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    const baseVal = (base as Record<string, unknown>)[key];
    const overVal = override[key];

    // 特殊对象类型直接替换（不递归合并）
    if (
      baseVal instanceof Date ||
      overVal instanceof Date ||
      baseVal instanceof RegExp ||
      overVal instanceof RegExp ||
      baseVal instanceof Map ||
      overVal instanceof Map ||
      baseVal instanceof Set ||
      overVal instanceof Set
    ) {
      (result as Record<string, unknown>)[key] = overVal;
      continue;
    }

    // 普通对象递归合并
    if (
      baseVal !== null &&
      overVal !== null &&
      typeof baseVal === 'object' &&
      typeof overVal === 'object' &&
      !Array.isArray(baseVal) &&
      !Array.isArray(overVal) &&
      !(baseVal instanceof Function) &&
      !(overVal instanceof Function)
    ) {
      (result as Record<string, unknown>)[key] = deepMerge(
        baseVal as Record<string, unknown>,
        overVal as Record<string, unknown>,
      );
    } else {
      (result as Record<string, unknown>)[key] = overVal;
    }
  }
  return result;
}

/**
 * `deepMerge` 函数源码字符串（const 声明形式）
 *
 * 供 `compileConfig` 生成 `dist/faapi-config.js` 时内联：esbuild bundle 入口源码引用此字符串，
 * 产物自包含 `deepMerge` 函数，运行时无需 import `@faapi/faapi` 内部模块。
 *
 * 通过 `deepMerge.toString()` 自动序列化函数源码，保证与运行时 `deepMerge` 完全一致。
 */
export const DEEP_MERGE_SOURCE = `const deepMerge = ${deepMerge.toString()};`;
