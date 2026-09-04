# createProgram

一句话概括：创建 TypeScript Program 用于 AST 分析,带模块缓存;从源文件向上查找最近的 `tsconfig.json` 读取 `module` / `moduleResolution`,保证业务项目用 `Bundler` resolution 时 checker 能解析跨文件 `import type`。批量场景用 `createPrograms` 按 tsconfig 分组共享同一个 Program。

## 为什么需要

参数校验需要分析 TypeScript interface 定义,需要创建 TS Program 来访问 AST。Program 创建开销大,故按文件路径缓存。

业务项目按 faapi skill 约定使用 `moduleResolution: Bundler` + 无扩展名相对导入(如 `import type { X } from '../../db/schema'`)。若 `createProgram` 硬编码 `NodeNext`,checker 在 ESM 解析阶段要求相对导入带文件扩展名,无扩展名的导入绑定不到声明 → `resolveTypeReference` 兜底抛"无法解析的引用类型",`faapi build` 中止。

因此 `createProgram` 需读取业务项目的 `tsconfig.json` 的 `module` / `moduleResolution`(与项目实际一致),让 checker 正确绑定跨文件 symbol。

## 导出

| 函数                         | 说明                                                                                                             |
| -------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `createProgram(file)`      | 创建 Program(命中缓存直接返回)。从 `file` 向上查找最近的 `tsconfig.json`,提取 `compilerOptions.module` / `moduleResolution` 与默认选项合并 |
| `createPrograms(files)`    | 批量创建 Program,**按 tsconfig 分组共享同一个 Program**(同一次生成只创建一个,见下文),返回 `Map<filePath, Program>`      |
| `invalidateProgramCache()` | 清空 Program 缓存(单文件 + 共享)+ tsconfig 解析缓存(dev watch 时调用,确保增量编译后读到最新 Program)                      |

## 批量共享(createPrograms)

`faapi build` 需要为全部路由/tool/agent 文件做 AST 提取。若逐文件调 `createProgram`,每个文件都会创建一个含全项目 rootNames 的 Program,重复解析整个项目源码——这是 build 时间的最大单项开销(大项目下为数量级差异)。

`createPrograms(filePaths)` 的共享规则:

1. 对每个文件向上查找 tsconfig.json,**查找到同一个 tsconfig 的文件共用同一个 Program**(rootNames = tsconfig fileNames ∪ 全部入口文件)
2. 跨文件类型解析语义与单文件 `createProgram` 完全一致(共享 Program 的 rootNames 包含全部入口文件,`resolveTypeReference` 兜底遍历不受影响)
3. 缓存 key 为 `shared::<tsconfigPath>::<排序后的文件列表>`——同一批次重复调用命中缓存;不同批次(rootNames 不同)各自创建
4. 查找不到 tsconfig.json 的文件(如测试场景)逐个回退单文件 `createProgram` 行为,不参与共享

调用方:`collectRouteSchemaSources` / `generateToolArtifacts` / `generateAgentArtifacts` 均已改为批量共享。

## 使用场景

- build / dev 时为 handler.ts / tool handler.ts / agent handler.ts 提取类型——批量提取走 `createPrograms` 共享 Program,单文件提取(dev 按需生成 zod.js)走 `createProgram`

- dev watch 文件变化时,先 `invalidateProgramCache()` 再重新提取

## tsconfig 解析规则

1. 从 `filePath` 所在目录开始,逐级向上查找 `tsconfig.json`
2. 找到后用 `ts.readConfigFile` 读取 + `ts.parseJsonConfigFileContent` 解析,**保留 tsconfig 原始 include/exclude/files**,让 ts 自动扫描所有相关 `.ts` 文件作为 program 的 rootNames
3. 仅提取 `compilerOptions.module` 和 `moduleResolution` 两个字段(其余字段如 `target` / `strict` / `skipLibCheck` 仍用框架默认值,避免业务项目的 `jsx` / `paths` 等干扰 AST 提取)
4. 解析结果(module / moduleResolution / fileNames)按 `tsconfig.json` 绝对路径缓存,避免每次 `createProgram` 重复读盘
5. 找不到 `tsconfig.json`(如测试场景的 `os.tmpdir()`)回退到默认值(`module: NodeNext` / `moduleResolution: NodeNext`),rootNames 仅包含 `filePath`

### 为什么要加载全部 fileNames 作为 rootNames

`ts.createProgram([filePath], options)` 不会自动通过 module resolution 把 import 的文件拉进 program。如果只传入口文件作为 rootNames,即使业务项目 tsconfig 用 `Bundler` resolution,program 也只包含入口文件本身,checker 拿不到跨文件 symbol。

通过 `parseJsonConfigFileContent` 拿到 `parsed.fileNames`(tsconfig include 模式匹配的所有 `.ts` 文件)作为 rootNames,program 会加载所有相关文件。这样 `resolveTypeReference` 即使在 `getAliasedSymbol` 失败时(noEmit 模式下 module resolution 可能未完全绑定 alias),也能通过遍历 program 的 sourceFiles 找到同名声明,完成跨文件类型解析。

只读取 `module` / `moduleResolution` 两个字段,理由:

- 这两个字段决定 checker 能否绑定跨文件 symbol,是修复 `import type` 解析问题的关键

- 其他字段(`target` / `strict` / `jsx` / `paths` / `baseUrl` 等)与 AST 类型提取无关,读取反而引入不确定性(如业务项目的 `jsx: react-jsx` 不应影响 handler.ts 的类型提取)

- 框架默认值(`strict: true` / `skipLibCheck: true` / `noEmit: true`)保证 AST 提取行为稳定

## 相关模块

- `extractHandlerTypes.ts` - 使用 Program 提取类型

- `extractToolMetadata.ts` - tool 元数据提取,使用 Program

- `extractAgentMetadata.ts` - agent 元数据提取,使用 Program

- `../cli/devCommand.ts` - watch 时调 `invalidateProgramCache`

- `../cli/buildCommand.ts` - 构建时调 `createProgram`

- `../cli/collectRouteSchemaSources.ts` - 路由 schema 提取,批量调 `createPrograms`

- `../cli/generateToolArtifacts.ts` - tool schema 提取,批量调 `createPrograms`

- `../cli/generateAgentArtifacts.ts` - agent 元数据提取,批量调 `createPrograms`

