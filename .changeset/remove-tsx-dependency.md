---
'@faapi/faapi': minor
---

移除 tsx 运行时依赖，faapi.config.ts 改由 esbuild 编译加载。

- `loadConfig` 用 esbuild 将 `.ts` 配置文件编译为临时 `.mjs` 后 import（`bundle: true` 支持本地相对 import）
- 产物路径基于源文件内容 SHA-1 哈希，内容未变化时跳过编译
- 移除 `cli/index.ts` 中的 `ensureTsx` / `isTsxPreloaded` 逻辑
- `esbuild` 从 `devDependencies` 移到 `dependencies`
- 用户项目无需再安装 tsx 即可使用 `faapi.config.ts`
