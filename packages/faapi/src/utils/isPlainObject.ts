export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  // 数组不是普通对象
  if (Array.isArray(value)) {
    return false;
  }

  // 检查原型链：普通对象的 prototype 是 Object.prototype 或 null（Object.create(null)）
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}
