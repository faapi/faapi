---
'@faapi/faapi': patch
---

修复跨文件 `import type` 解析失败:业务项目用 `moduleResolution: Bundler` + 无扩展名相对导入时,`faapi build` / tool schema 提取抛 `SchemaExtractionError`

## 根因

`createProgram` 硬编码 `moduleResolution: NodeNext`,而业务项目用 `Bundler`。NodeNext 的 ESM 解析要求相对导入带文件扩展名,无扩展名的 `import type { X } from '../../db/schema'` 绑定不到声明,checker 拿不到跨文件 symbol,`resolveTypeReference` 兜底抛"无法解析的引用类型"。

## 修复

- **`createProgram` 读项目 tsconfig**:用 `ts.parseJsonConfigFileContent` 解析业务项目 `tsconfig.json`,取 `module` / `moduleResolution` 覆盖默认 NodeNext,同时取 `parsed.fileNames` 作为 program 的 rootNames(让跨文件 import 的源文件被加载进 program)
- **`resolveImportAlias` 增加 program 兜底遍历**:`checker.getAliasedSymbol` 失败时(如 `noEmit` 模式下 alias 未完全绑定),遍历 program 所有非 lib sourceFile 的顶层声明找同名 `InterfaceDeclaration` / `TypeAliasDeclaration` / `EnumDeclaration`
- **模块级 program 上下文**:因 `TypeChecker` 运行时未暴露 `getProgram()`,新增 `setProgramContext(program)` 由 `extractTypeInfo` / `extractAllTypes` 在分析前后设置/清空

## 业务方影响

- tool / route handler 的 input interface 可正常引用跨文件类型(如 db schema),无需内联重复声明
- 与 faapi skill 文档"moduleResolution: Bundler,本地相对导入不写后缀"约定一致
- 无 API 变更,向后兼容
