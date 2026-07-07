# deepMerge

一句话概括：深度合并两个配置对象，同时为 `compileConfig` 提供源码字符串内联到 build 产物。

## 为什么需要

`compileConfig` 在编译阶段（dev 启动时 / build 时）把基础配置 `faapi.config.ts` 与环境配置 `faapi.config.{env}.ts` 深度合并——后者覆盖前者同名 key，普通对象递归合并，特殊类型（数组/Date/RegExp/Map/Set/函数）直接替换。合并结果固化为 `faapi-config.js` 产物,`loadConfig` 运行时零合并,只读产物。

`compileConfig` 在 build 时把同样的合并预编译到 `.faapi/build/faapi-config.js`，运行时零合并。为避免两处独立实现导致逻辑不一致，统一从本模块导出：

- `deepMerge` 函数：`compileConfig` 编译期使用
- `DEEP_MERGE_SOURCE` 字符串常量：通过 `deepMerge.toString()` 序列化函数源码，供 `compileConfig` 内联到 esbuild 入口源码

## 使用场景

- `compileConfig` 编译阶段（dev 启动时 + build 时）合并基础配置与环境配置,生成 `faapi-config.js`
- `loadConfig` 运行时只读 `faapi-config.js`,不再现场合并

## 合并规则

| 类型 | 行为 |
|------|------|
| 普通对象 | 递归合并（后者覆盖前者同名 key） |
| `null` / `undefined` | 非空值优先 |
| 数组 | 直接替换（不递归合并） |
| `Date` / `RegExp` / `Map` / `Set` | 直接替换 |
| 函数 | 直接替换 |

## DRY 保证

`DEEP_MERGE_SOURCE = `const deepMerge = ${deepMerge.toString()};``

通过 `Function.prototype.toString()` 自动序列化函数源码，无需手动维护字符串副本。`compileConfig` 内联此字符串到 esbuild 入口源码后，`.faapi/build/faapi-config.js` 自包含 `deepMerge` 函数，运行时不依赖 `@faapi/faapi` 内部模块。

## 相关模块

- [cli/compileConfig.ts](../cli/compileConfig.ts) - 编译阶段合并配置,使用 `deepMerge` 函数与 `DEEP_MERGE_SOURCE` 字符串
- [config/loadConfig.ts](./loadConfig.ts) - 运行时只读 `faapi-config.js` 产物,不再现场合并
