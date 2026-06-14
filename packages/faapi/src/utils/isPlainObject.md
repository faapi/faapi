# isPlainObject

一句话概括：判断值是否为普通 JavaScript 对象。

## 为什么需要

响应处理时需要区分普通对象和类实例（如 Date、RegExp）。普通对象应序列化为 JSON，类实例可能需要特殊处理。

## 使用场景

- 响应值判断
- 区分对象和数组
- 类型守卫

## 相关模块

- `toResponse.ts` - 判断返回值类型
