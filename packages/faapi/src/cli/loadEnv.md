# loadEnv

一句话概括：按 Next.js 约定加载 `.env` 系列文件到 `process.env`，供 `faapi.config.ts` 和 handler 通过 `process.env.XXX` 读取环境变量。

## 为什么需要

faapi 需要统一的环境变量加载机制，让数据库连接、API 密钥等可变配置脱离 `faapi.config.ts` 源码：

- **配置与密钥分离**：`faapi.config.ts` 只写结构化配置（端口、CORS 策略等），敏感值通过 `process.env.DB_URL` 读取
- **多环境差异**：dev/prod 用不同 `.env.{env}` 文件，无需 `faapi.config.{env}.ts` 多环境配置文件
- **12-Factor App 合规**：环境变量驱动配置，便于容器化部署

参考 Next.js 的 `.env` 加载方案，支持 `.env` / `.env.local` / `.env.{env}` / `.env.{env}.local` 四级文件，shell 变量优先。

## 使用场景

- `faapi dev` 启动时：`devCommand` 最早阶段先兜底 `NODE_ENV=development`（未显式设置时），再调 `loadEnv(rootDir)`
- `node dist/main` 启动时：`main.js` 入口最早阶段先兜底 `NODE_ENV=production`（未显式设置时），再调 `loadEnv(cwd)`
- 编程式调用：用户在 `createProdApp` 之前手动调用 `loadEnv`

## API

| 方法 | 说明 |
|------|------|
| `loadEnv(rootDir)` | 加载 `.env` 系列文件到 `process.env` |

参数：

| 参数 | 类型 | 说明 |
|------|------|------|
| `rootDir` | `string` | 项目根目录（`.env` 文件所在目录） |

## 行为

### env 决定规则

```
env = NODE_ENV || 'development'
```

调用方应在调 `loadEnv` 之前自行兜底 `NODE_ENV`（dev 设 `'development'`，prod 设 `'production'`），让 `loadEnv` 能读到正确的 `NODE_ENV` 决定加载哪个 `.env.{env}` 文件。

### 文件加载顺序（从低到高优先级）

1. `.env` — 所有环境共享
2. `.env.local` — 本地覆盖（不提交 git）
3. `.env.{env}` — 按环境覆盖（如 `.env.production`）
4. `.env.{env}.local` — 按环境本地覆盖（不提交 git）

后加载的文件覆盖先加载的同名变量。

### process.env 合并规则

- **shell 已设置的变量不被覆盖**：`export DB_HOST=xxx && faapi dev` 时 `.env` 中的 `DB_HOST` 不生效
- **文件间覆盖**：后加载的文件覆盖先加载的同名变量（`.env.production.local` > `.env.production` > `.env.local` > `.env`）

### .env 文件格式

- `KEY=VALUE` — 基本格式
- `# 注释` — 行首注释（`#` 前可有空白）
- `export KEY=VALUE` — 支持 `export` 前缀
- 单引号 `'value'` — 字面量，不展开变量，不处理转义
- 双引号 `"value"` — 支持变量展开（`$VAR` / `${VAR}`）和转义（`\n` `\t` `\r` `\\` `\"`）
- 无引号 `value` — 字面量，` #` 后为行内注释
- 空行忽略
- KEY 必须符合 `[A-Za-z_][A-Za-z0-9_]*`

变量展开优先级：已解析的 .env 变量 > `process.env` > 空字符串

## dev/prod 一致性

`loadEnv` 是纯函数式工具，dev 和 prod 走完全相同的加载逻辑（读 `NODE_ENV` 决定加载哪个 `.env.{env}`），差异仅由调用方在调 `loadEnv` 之前兜底的 `NODE_ENV` 值驱动。dev 模式不 watch `.env` 文件变化（环境变量变更需重启服务，与 Next.js 行为一致）。

## 相关模块

- [cli/devCommand.ts](./devCommand.ts) - dev 命令，启动时兜底 `NODE_ENV=development` 后调 `loadEnv(rootDir)`
- [cli/buildCommand.ts](./buildCommand.ts) - build 命令，生成 `main.js` 时注入 `NODE_ENV` 兜底 + `loadEnv` 调用
- [config/loadConfig.ts](../config/loadConfig.ts) - 运行时配置加载（`faapi.config.ts` 中通过 `process.env.XXX` 读取 loadEnv 注入的变量）
