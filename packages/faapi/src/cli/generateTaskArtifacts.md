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
- zod.js：对每个任务文件的 `run` 函数提取首参类型名（extractToolMetadata，functionName='run'），有类型名则用 tool 同款管线（collectTaskSchemaSources → generateToolSchemaFileSource，coerce=false）写 `<dist>/tasks/<dir>/zod.js`，导出 `${typeName}Schema`；无类型名跳过（运行时同样跳过校验）
- 无任务文件时仍写空清单（`export const tasks = []`），运行时队列空转

## 相关模块

- `src/cli/generateToolArtifacts.ts` — schema 生成管线复用（generateToolSchemaFileSource / getSchemaOutputPath）
- `src/cli/createAppCore.ts` — loadAndHydrateTasks 水合
- `src/task/scanTasks.ts` — 输入来源
