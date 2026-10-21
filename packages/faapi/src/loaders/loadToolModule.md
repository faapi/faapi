# loadToolModule

一句话概括:动态加载 tool handler 模块并提取指定函数名的导出。dev 按需编译模式下,先 `ensureCompiled` 确保产物存在再 import,避免 import 不存在的文件。

## 为什么需要

tool handler 文件需要动态 import,提取对应的 tool 函数(`functionName`),供 `toolRegistry` 调用。

与 [loadRouteModule](./loadRouteModule.md) 同构设计——dev 按需编译模式(Vite 风格)下,tool handler.js 不在启动时预编译(由 `generateToolArtifacts` 的 `skipSchema` 选项控制,启动时只生成 `faapi-tools.js` 清单)。首次 agent 调用 tool 时,`loadToolModule` 先调 `ensureCompiled` 确保产物已生成,再 import。详见 [compileOnDemand](../cli/compileOnDemand.md)。

## 使用场景

- agent 调用 tool 时加载 tool 模块(`toolRegistry.getTool(name)` → `loadToolModule(filePath, functionName, rootDir)`)
- 提取 `getWeather` / `search` / `ping` 等 tool 函数
- 校验模块导出合法性(函数类型)
- dev 模式下先触发按需编译再 import

## 流程

```
loadToolModule(filePath, functionName, rootDir)
  ├─ if (isDevOnDemandEnabled() && rootDir):
  │    ├─ prodPathToSourcePath(filePath, rootDir, dist) → 源码 .ts 路径
  │    ├─ ensureCompiled(sourcePath, rootDir, dist)
  │    │    ├─ compiledFiles.has → 跳过
  │    │    ├─ mtime fresh → 跳过
  │    │    └─ compileDevRoutes({ files: [sourcePath] }) → 单文件编译
  │    └─ 编译失败 → 抛 "Failed to compile tool module"
  ├─ importWithCacheBust(filePath, bustViteCache=isDevOnDemandEnabled())
  │    └─ dev 按需模式:走 Node 原生 import + 时间戳 query 绕过 Vite SSR 缓存
  ├─ resolveExport(module, functionName)
  │    ├─ 具名导出:export function getWeather() {}
  │    └─ 默认导出的对象属性:export default { getWeather() {} }
  └─ 校验是否为函数(否则抛 "does not export a valid function")
```

`rootDir` 参数仅 dev 按需编译模式用(用于反推源码路径触发编译),prod 模式可省略。

## 与 loadRouteModule 的差异

| 维度 | loadRouteModule | loadToolModule |
| --- | --- | --- |
| 第二参数 | `method`(HTTP 方法名,如 `GET`) | `functionName`(源码导出名,如 `getWeather`) |
| 返回类型 | `{ handler, method }` | `{ handler, functionName }` |
| 模块类型 | `RouteModule` | `ToolModule` |
| 复用 | `resolveExport` / `validateRouteModule` | `resolveExport` + 内联函数校验 |
| dev 按需编译 | `ensureCompiled` | `ensureCompiled`(同源复用) |

`functionName` 与 `method` 的语义差异:
- `method` 是固定枚举(`GET` / `POST` / `PUT` / `DELETE` / `PATCH`),与 HTTP 协议绑定
- `functionName` 是任意合法标识符(如 `getWeather` / `search` / `add`),由业务方自定义

## 为什么先编译再 import(而非 import 失败后重试)

与 `loadRouteModule` 一致——避免 import 不存在的文件污染 Vite SSR 内部状态(vitest 环境下会导致后续重试 import 仍失败)。详见 [loadRouteModule](./loadRouteModule.md) 的同名章节。

## 校验为何内联(不单独写 validateToolModule)

`validateRouteModule` 的错误消息提到 "method",对 tool 语义不准确。但 tool 的校验逻辑与路由完全一致(只需判断是否为函数),单独抽 `validateToolModule` 模块会增加文件而无新逻辑。故 `loadToolModule` 内联校验,错误消息提到 "tool" 和 `functionName`,保证可读性。

## 相关模块

- [loadRouteModule](./loadRouteModule.md) - 路由模块加载(同构设计参考)
- [resolveExports](./resolveExports.md) - 从模块对象解析指定名称导出
- [importWithCacheBust](../utils/importWithCacheBust.md) - ESM cache bust 加载(`bustViteCache` 参数:dev 按需模式下走 Node 原生 import)
- [compileOnDemand](../cli/compileOnDemand.md) - dev 按需编译核心(`ensureCompiled` + `isDevOnDemandEnabled` + `getDevDist` + `prodPathToSourcePath`)
- [generateToolArtifacts](../cli/generateToolArtifacts.md) - 上游产出 `faapi-tools.js`(含 `filePath` 和 `functionName`)
- [toolRegistry](../injection/toolRegistry.md) - 调用方,运行时 tool 注册表
