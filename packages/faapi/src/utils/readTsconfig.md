# readTsconfig

一句话概括：读取项目 tsconfig.json，提取 baseUrl + paths，规范化为绝对路径配置。

## 为什么需要

faapi 在编译时用 esbuild 逐文件编译（`bundle:false`），默认不读 tsconfig，不会重写 `@/` 别名。产物 `dist/**/*.js`（或 `.faapi/**/*.js`）原样保留 `import '@/foo'`，运行时无 loader 会解析失败。

dev 和 build 模式都先编译 `.ts` 到 `.js`，编译时需读 tsconfig，把别名重写为相对路径写入产物。

两处都需要同一份「baseUrl + paths」配置，且都要求路径已规范化为绝对路径（相对路径在运行时无法跨文件解析），故抽取为独立工具。

## 使用场景

- `compileDevRoutes.ts` / `compileBuildRoutes.ts` 编译时调用，构造 esbuild 别名重写插件
- dev 模式（`.faapi/`）和 build 模式（`dist/`）共用

## 相关模块

- `resolveAlias.ts` - 消费本模块返回的配置，做 specifier → 绝对路径解析
- `compileDevRoutes.ts` / `compileBuildRoutes.ts` - 编译时调用本模块读取 tsconfig paths 配置
