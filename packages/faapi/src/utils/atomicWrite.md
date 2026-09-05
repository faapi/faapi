# atomicWrite

一句话概括：原子写文件——先写临时文件再 rename 替换，保证并发读者看不到半成品。

## 为什么需要

运行时会 import 的产物（zod.js、faapi-routes.js、faapi-tools.js、faapi-agents.js）
在 dev watch 重建与在途请求并发时，非原子写（直接 `fs.writeFile` 覆盖）会让请求
import 到截断的半成品文件，报 SyntaxError/ENOENT 且错误信息完全不指向根因。
handler.js 早已通过 esbuild `write:false` + tmp + rename 原子写，本工具把同一
语义推广到其余产物写入点。

rename 在同一文件系统上是原子的（POSIX）：读者要么看到旧文件要么看到新文件。

## 使用场景

- `generateSchemaFiles` 写 zod.js 与 faapi-helpers.js（请求路径上按需生成 + import）
- `generateToolArtifacts` 写 faapi-tools.js 与 tool zod.js
- `generateAgentArtifacts` 写 faapi-agents.js
- `generateRoutes` 写 faapi-routes.js

## 相关模块

- `generateSchemaFiles.ts` / `generateToolArtifacts.ts` / `generateAgentArtifacts.ts` / `generateRoutes.ts` - 消费者
- `compileSourceFiles.ts` - esbuild 产物的同源原子写实现（write:false + 手动 rename）
