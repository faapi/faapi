---
"@faapi/faapi": minor
---

CLI 默认 `--app-dir` 从 `.`（项目根目录）改为 `src`，默认扫描 `src/api/**/*.ts`。

**Breaking change**：现有项目若路由放在根目录 `api/` 下，需显式 `--app-dir .` 回退，或迁移到 `src/api/`。

**向后兼容**：`--app-dir .` 仍然扫描 `api/**/*.ts`，prod 映射到 `dist`。

**动机**：与 Next.js `src/app` 目录结构对齐，统一前端代码到 `src/` 下，集成 Next.js 时形态更自然（`src/api/` + `src/app/` 或 `app/`）。
