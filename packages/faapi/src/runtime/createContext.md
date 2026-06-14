# createContext

一句话概括：从 Request 创建请求上下文。

## 为什么需要

将 Web 标准 Request 对象转换为 faapi 上下文，提取 params、query、headers 等信息。

## 使用场景

- 请求处理时创建上下文
- 提取请求相关信息
- 执行 config.extendContext 扩展钩子（用户可挂载自定义 ctx 方法）

## 相关模块

- `contextTypes.ts` - 类型定义
- `invokeHandler.ts` - 使用上下文
- `configTypes.ts` - extendContext 钩子定义
