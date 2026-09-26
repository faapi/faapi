# generateZodArtifacts

一句话概括：routes / tools / tasks 三条产物管线共享的 zod.js 生成流程——分组、算 helpers import 路径、生成源码、按需生成 faapi-helpers.js、并行原子写。

## 为什么需要

三条产物管线（路由/tool/任务的 Payload schema）的 zod.js 生成流程完全同构，此前是三份复制粘贴：新增字段（如 coerce 语义）或产物布局调整要同步改三处，且 strip src 前缀的目录推导在各处内联重复（`prodPaths.ts` 的既有约定未复用）。收敛为单一管线后，差异项只有「每文件生成源码的回调」与「源列表」两个参数。

## 使用场景

- `generateSchemaFiles.ts` — 路由 zod.js（GETQuery/POSTBody 等）
- `generateToolArtifacts.ts` — tool 输入 zod.js（`skipSchema` 时上游不进入本管线）
- `generateTaskArtifacts.ts` — 任务 Payload zod.js

## 行为约定

- 按源文件绝对路径分组：同一 handler.ts 的多个方法合并进同一个 zod.js（命名类型声明文件级去重依赖此语义）
- 产物布局：源文件剥 `src/` 前缀后同级目录写 `zod.js`；`faapi-helpers.js` 固定在 dist 根部
- helpers 生成条件：任一 zod.js 源码引用 coerce 函数；**已存在时跳过**（三条管线共享一份，先到的生成——与 routes 管线旧「总是写」的差异已被 accepts-existing 语义统一，内容确定性一致）
- 全部文件并行原子写：dev watch 重建与在途请求并发时，请求侧 import 不到半成品

## 相关模块

- `generateSchemaFiles.ts` — `getSchemaOutputPath` / `getHelpersImportPath`（产物布局的权威定义）
- `../ast/generateZodSchema.ts` — 源码生成 + coerce helpers 源码
- `../utils/atomicWrite.ts` — 原子写
