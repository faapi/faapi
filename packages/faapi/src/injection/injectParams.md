# injectParams

一句话概括：根据注入信息，准备参数值并调用 handler。

## 为什么需要

`resolveInjection` 分析出需要注入什么，`injectParams` 负责准备对应的值并按正确顺序传给 handler。

## 使用场景

- 路由 handler 调用前准备参数
- 根据 context 提取 query、body、headers 等
- 执行参数校验

## 相关模块

- `resolveInjection.ts` - 提供注入信息
- `validateInput.ts` - 参数校验
