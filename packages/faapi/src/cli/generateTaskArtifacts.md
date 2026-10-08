# generateTaskArtifacts

一句话概括：从 TaskManifest[] 生成 `faapi-tasks.js` 任务清单产物 + 各任务目录的 `zod.js`（run 首参类型的 Payload schema），dev/prod 行为一致（全量生成）。

## 为什么需要

与 faapi-routes.js / faapi-tools.js 同构的产物三元组一员：运行时 `createAppBase` 只读清单产物水合 registry，不重新扫描源码；Payload zod 校验需要 schema 产物。

## 使用场景

- `faapi dev` 启动与 watcher `reloadTasks`
- `faapi build` 构建期

## 行为约定

- `serializeTasks(manifests, dist)`：filePath 转 `toProdFilePath` 产物形式，meta 字段透传
- `writeTasksModule` 写 `<dist>/faapi-tasks.js`：`export const tasks = [...]`（JSON.stringify 嵌入）
- `hydrateTasks(serialized)`：JSON 还原 TaskMetadata[]
- zod.js：对每个任务文件的 `run` 函数提取首参类型名（extractToolMetadata，functionName='run'），用 tool 同款管线（collectTaskSchemaSources → generateToolSchemaFileSource，coerce=false）写 `<dist>/tasks/<dir>/zod.js`，导出 `${typeName}Schema`
- **Payload 声明必填（不跳过）**：`run` 首参无可提取的类型名（`run()` 无参 / 参数无类型标注 / 未导出 `run` 函数）→ 构建期抛错，逐个列出任务名与修复指引。确无入参契约的任务显式声明 `type Payload = unknown`——生成恒通过的 `z.unknown()` schema，沿用「显式 unknown = 不校验」既有语义。理由：无声明即跳过校验是静默降级（payload 契约缺失悄悄放行），契约缺失必须在构建期显式失败
- 无任务文件时仍写空清单（`export const tasks = []`），运行时队列空转

> zod.js 的分组/写入/helpers 生成流程由 `generateZodArtifacts` 共享管线执行（与 routes/tools 同一份）。

## 相关模块

- `src/cli/generateToolArtifacts.ts` — schema 生成管线复用（generateToolSchemaFileSource / getSchemaOutputPath）
- `src/cli/createAppCore.ts` — loadAndHydrateTasks 水合
- `src/task/scanTasks.ts` — 输入来源
