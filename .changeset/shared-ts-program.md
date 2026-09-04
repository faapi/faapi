---
'@faapi/faapi': minor
---

构建性能优化：schema/tool/agent 产物生成改为批量共享 TypeScript Program（新增 `createPrograms` 公开导出）。此前每个 handler 文件单独创建一个含全项目源码的 Program，N 个文件重复解析 N 遍；现在同一次生成中查找到同一 `tsconfig.json` 的文件共用一个 Program，`faapi build` 与 dev 首次请求生成 zod.js 的 AST 阶段开销从 O(N×全项目) 降为 O(全项目)，大项目下提升数量级。跨文件 `import type` 解析语义不变。
