# parseArgs

一句话概括：解析 CLI 命令行参数，识别 dev/start 命令词。

## 为什么需要

用户通过命令行启动服务，需要解析参数（端口、路由模式、app 目录等），转换为结构化配置。同时识别命令词（`dev`/`start`）决定启动模式。

## 使用场景

- CLI 启动时解析参数
- 支持选项和位置参数
- 识别 `dev`/`start` 命令词，设置 `mode` 字段
- 返回结构化配置对象

## 命令词与 mode

| 命令词 | mode | 行为 |
|--------|------|------|
| `faapi` / `faapi dev` | `dev` | 编译 `.ts` → `.faapi/dev/*.js`，watch，预生成 schema |
| `faapi start` | `start` | 加载 `dist/faapi-routes.js` + `dist/faapi-schema.js`，不 watch |

命令词作为位置参数的第一个非选项词识别，不进入 `patterns`。`build` 命令词由 `cli/index.ts` 顶层分发，不进 `parseArgs`。

## 相关模块

- `normalizePatterns.ts` - 标准化路由模式
- `startCommand.ts` - 使用解析结果（按 mode 走 dev/prd 分支）
- `index.ts` - 顶层命令分发（build 独立，dev/start 共用 startCommand）
