# toResponse

一句话概括：将 handler 返回值转换为 Response。

## 为什么需要

handler 可能返回各种类型（对象、字符串、null 等），需要统一转换为 Web 标准 Response。

## 使用场景

- 转换 handler 返回值
- 设置正确的 Content-Type
- 处理空响应

## 相关模块

- `isPlainObject.ts` - 判断对象类型
- `invokeHandler.ts` - 调用此函数
