# collectImports

一句话概括：递归收集入口文件在项目内的全部 import 依赖（含传递依赖、tsconfig paths 别名），按 src 内/外分组。

## 为什么需要

逐文件编译（`bundle: false`）不分析 import 关系，产物只包含被显式编译的文件。两个场景因此必须补齐依赖闭包：

- **compileConfig**：config 产物 import 引用的项目模块（如自定义错误类），这些模块必须与 routes 共享同一份产物，`instanceof` 才能跨边界生效。
- **compileOnDemand（dev 按需编译）**：`ensureCompiled` 若只编译 handler 单文件，handler 引用的共享模块（`../../lib/db`）没有产物，首次请求 import 即 `ERR_MODULE_NOT_FOUND`。

## 使用场景

- `compileConfig` 步骤 1：收集 config 引用的项目模块，src 内/外分别用不同 outbase 编译
- `compileOnDemand.ensureCompiled`：编译 handler 前收集依赖闭包，批量传入 esbuild
- 其他需要"编译一个文件时保证其项目内依赖也存在产物"的场景

## 解析规则

- 相对 specifier（`./`、`../`）：`resolveRelativeSpecifier` 探测 `.ts`/`.tsx` 等源后缀与 `index` 文件
- 别名 specifier（tsconfig paths，如 `@/lib/db`）：`resolveAlias` 解析候选目标后同样探测源后缀；无 tsconfig/paths 时跳过
- 已带产物后缀（`.js`/`.mjs`/`.cjs`）的 specifier 不递归——视为已编译产物
- 项目外依赖（node_modules、rootDir 外）不收集——按 external 语义运行时解析

## 相关模块

- `aliasPlugin.ts` - 提供 `resolveRelativeSpecifier`（相对 specifier 探测）
- `utils/resolveAlias.ts` + `utils/readTsconfig.ts` - tsconfig paths 别名解析
- `compileConfig.ts` - 步骤 1 消费者（config 依赖闭包）
- `compileOnDemand.ts` - `ensureCompiled` 消费者（handler 依赖闭包）
