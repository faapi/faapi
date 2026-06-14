# contextTypes

一句话概括：定义请求上下文 FaapiContext 及 ctx.config 类型（FaapiContextConfig）的结构。

## 为什么需要

运行时多个模块（createContext、resolveInput、invokeHandler、injectParams）都需要访问请求上下文。集中定义确保所有模块使用统一的上下文结构。FaapiContext 和 FaapiContextConfig 均为导出 interface，用户可通过 `declare module '@faapi/faapi'` 增强类型。

## 使用场景

- `createContext` 创建 FaapiContext 实例
- `resolveInput` 从 FaapiContext 提取输入
- `invokeHandler` 将 FaapiContext 传给 handler
- `injectParams` 从 FaapiContext 注入参数
- 用户 `declare module '@faapi/faapi'` 增强 FaapiContext（自定义方法）或 FaapiContextConfig（ctx.config 类型）

## 相关模块

- `createContext.ts` - 创建 FaapiContext 实例
- `resolveInput.ts` - 从上下文提取输入
- `invokeHandler.ts` - 使用上下文调用 handler
