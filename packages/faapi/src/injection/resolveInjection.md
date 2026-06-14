# resolveInjection

一句话概括：分析函数参数，决定需要注入什么内容。

## 为什么需要

传统方式参数顺序固定（query, context），不够灵活。新系统通过分析参数名，自动决定注入内容，让开发者只声明需要的参数。

## 使用场景

- 路由 handler 调用前分析参数
- 决定需要准备哪些注入值
- 提取类型信息用于校验

## 相关模块

- `injectParams.ts` - 使用分析结果执行注入
- `extractHandlerTypes.ts` - 提取类型信息
