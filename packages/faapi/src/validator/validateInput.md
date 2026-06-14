# validateInput

一句话概括：校验输入参数。

## 为什么需要

根据 TypeScript interface 定义，在运行时校验输入参数，确保类型正确、必填字段存在。

## 使用场景

- 请求处理时校验参数
- 返回校验结果和问题列表

## 相关模块

- `createProgram.ts` - 创建 TS Program
- `extractHandlerTypes.ts` - 提取类型信息
- `generateValidatorCode.ts` - 生成校验函数代码
