/**
 * 隔离任务配置快照：把宿主进程配置投影为可跨线程的纯数据。
 *
 * 语义（见 configSnapshot.md）：
 * - 函数值 / symbol 值不进快照（与 registries 快照同款能力边界——宿主回调面不跨线程）
 * - 其余值必须可结构化克隆；非函数不可克隆值（Promise/WeakMap 等）显式抛错列路径（fail fast）
 * - Date/Map/Set 等整体可克隆子树原样保留（structuredClone 保真，非 JSON 变形）
 */

const failures: unique symbol = Symbol('faapi-config-snapshot-failure');

type Projection = unknown | typeof failures;

function projectValue(value: unknown, path: string, failedPaths: string[]): Projection {
  if (typeof value === 'function' || typeof value === 'symbol') return failures;
  if (value === null || typeof value !== 'object') return value;
  // 整体可克隆的子树原样保留（Map/Set/Date/类实例等走 structuredClone 语义）
  try {
    structuredClone(value);
    return value;
  } catch {
    // 不可整体克隆 → 逐属性下探（普通对象/数组），下探后仍不可克隆的报错
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (let i = 0; i < value.length; i++) {
      const projected = projectValue(value[i], `${path}[${i}]`, failedPaths);
      // 函数元素剔除保位序（占位 undefined），其余照常
      out.push(projected === failures ? undefined : projected);
    }
    return out;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto === Object.prototype || proto === null) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const projected = projectValue(child, `${path}.${key}`, failedPaths);
      if (projected !== failures) out[key] = projected;
    }
    return out;
  }
  // 非 plain 对象且整体克隆失败（Promise/WeakMap 等）：显式失败，不剔除不降级
  failedPaths.push(path);
  return failures;
}

export function collectConfigSnapshot(config: unknown): unknown {
  const failedPaths: string[] = [];
  const snapshot = projectValue(config, 'config', failedPaths);
  if (failedPaths.length > 0) {
    throw new Error(
      `[faapi] task config contains values that cannot cross the worker boundary at: ` +
        `${failedPaths.join(', ')}. Isolated tasks receive a pure-data config snapshot; ` +
        `replace these values with plain data or pass them via payload.`,
    );
  }
  // 最终自检：投影整体必须可结构化克隆（防御下探未覆盖的形态，如 symbol 键）
  try {
    structuredClone(snapshot);
  } catch (err) {
    throw new Error(
      '[faapi] task config snapshot could not be structured-cloned after projection. ' +
        'This is a framework bug — please report it with the config shape.',
      { cause: err },
    );
  }
  return snapshot;
}
