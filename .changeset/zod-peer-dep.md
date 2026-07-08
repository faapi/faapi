---
'@faapi/faapi': minor
'@faapi/mcp': minor
'@faapi/schema': minor
---

将 `zod` 从 `dependencies` 改为 `peerDependencies`。

## 背景

框架生成的 `zod.js`（每个 handler 一个，运行时按需 import 做 `safeParse`）位于业务方项目目录（dev `.faapi/**/zod.js`、prod `dist/**/zod.js`），顶部固定为 `import { z } from 'zod'`。

此前 `zod` 声明在 `@faapi/faapi` 的 `dependencies`，pnpm 严格 node_modules 布局下 zod 被隔离在 `node_modules/@faapi/faapi/node_modules/zod`，不会提升到项目根。Node ESM 解析器从 `.faapi/**/zod.js` 向上查找 `node_modules/zod` 失败，报 `Cannot find package 'zod'`。

## 变更

- `@faapi/faapi`：`zod` 从 `dependencies` 移到 `peerDependencies`
- `@faapi/mcp`：同上（运行时直接 import zod）
- `@faapi/schema`：删除冗余 `dependencies.zod`（不直接 import），改为 `peerDependencies` 保持一致

## 业务方升级指南

业务方需在项目 `package.json` 显式安装 `zod@^4`：

```bash
pnpm add zod@^4
# 或
npm install zod@^4
```

与框架版本保持一致即可（当前 `^4.4.3`）。
