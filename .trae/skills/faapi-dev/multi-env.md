# 场景:多环境配置

## 何时加载

用户要为 dev/prod/test 等环境配置不同环境变量，或理解 `.env` 文件加载逻辑。

## 机制

faapi 参考 Next.js 实现，通过 `loadEnv` 在启动时加载 `.env` 系列文件到 `process.env`，`faapi.config.ts` 和 handler 通过 `process.env.XXX` 读取。不再使用 `faapi.config.{env}.ts` 多环境配置文件。

## env 决定规则

```
env = NODE_ENV || 'development'
```

调用方在调 `loadEnv` 之前自行兜底 `NODE_ENV`：

- dev：`devCommand` 兜底设 `NODE_ENV=development`（未显式设置时）
- prod：`main.js` 入口兜底设 `NODE_ENV=production`（未显式设置时）

用户显式设置的 `NODE_ENV` 优先（如 `NODE_ENV=staging faapi dev` 加载 `.env.staging`）。

## 文件加载顺序

从低到高优先级（后者覆盖前者）：

1. `.env` — 所有环境共享
2. `.env.local` — 本地覆盖（不提交 git）
3. `.env.{env}` — 按环境覆盖（如 `.env.production`）
4. `.env.{env}.local` — 按环境本地覆盖（不提交 git）

**shell 已设置的变量不被覆盖**：`export DB_HOST=xxx && faapi dev` 时 `.env` 中的 `DB_HOST` 不生效。

## 加载时机

- **dev**：`faapi dev` 启动时（`devCommand` 最早阶段）先兜底 `NODE_ENV=development`（未显式设置时），再调 `loadEnv(rootDir)`
- **prod**：`node dist/main` 启动时（`main.js` 入口最早阶段）先兜底 `NODE_ENV=production`（未显式设置时），再调 `loadEnv(cwd)`
- dev 模式不 watch `.env` 文件变化（环境变量变更需重启服务，与 Next.js 行为一致）

## 使用方式

### 1. 创建 .env 文件

```bash
# .env — 所有环境共享（默认 gitignore，本地维护）
DB_HOST=localhost
DB_PORT=5432
REDIS_URL=redis://localhost:6379
```

```bash
# .env.production — 生产环境覆盖（可提交以共享环境配置）
DB_HOST=db.production.com
REDIS_URL=redis://redis.production.com:6379
```

```bash
# .env.local — 本地覆盖（gitignore，个人开发用）
DB_HOST=my-local-db
```

### 2. faapi.config.ts 中读取

```ts
import type { FaapiConfig } from '@faapi/faapi';

export default {
  db: {
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? '5432'),
  },
  redis: {
    url: process.env.REDIS_URL ?? 'redis://localhost:6379',
  },
} satisfies FaapiConfig;
```

### 3. handler 中读取

```ts
export function GET(ctx) {
  // ctx.config.db.host 来自 faapi.config.ts 中 process.env.DB_HOST
  return { dbHost: ctx.config.db.host };
}
```

## .env 文件格式

- `KEY=VALUE` — 基本格式
- `# 注释` — 行首注释（`#` 前可有空白）
- `export KEY=VALUE` — 支持 `export` 前缀
- 单引号 `'value'` — 字面量，不展开变量，不处理转义
- 双引号 `"value"` — 支持变量展开（`$VAR` / `${VAR}`）和转义（`\n` `\t` `\r` `\\` `\"`）
- 无引号 `value` — 字面量，` #` 后为行内注释
- 空行忽略
- KEY 必须符合 `[A-Za-z_][A-Za-z0-9_]*`

变量展开优先级：已解析的 .env 变量 > `process.env` > 空字符串

## .gitignore 规则

项目根 `.gitignore` 已包含：

```
.env
.env.local
.env.*.local
```

- `.env` / `.env.local` / `.env.{env}.local` — 本地维护，不提交
- `.env.{env}`（如 `.env.production`）— 可提交以共享环境配置

## 编程式调用

```ts
import { loadEnv, createProdApp } from '@faapi/faapi';

if (!process.env.NODE_ENV) process.env.NODE_ENV = 'production';
loadEnv(process.cwd());
const app = await createProdApp();
await app.listen();
```

## 常见坑点

### 1. 期望 .env 变化自动生效

dev 模式不 watch `.env` 文件。修改 `.env` 后需重启 `faapi dev`。

### 2. shell 变量优先

```bash
# .env 中 DB_HOST=localhost
export DB_HOST=override-host
faapi dev
# process.env.DB_HOST === 'override-host'（.env 不覆盖 shell 变量）
```

### 3. NODE_ENV 被测试框架设置

vitest/jest 会设置 `NODE_ENV=test`，导致 `loadEnv` 加载 `.env.test` 而非 `.env.development`。测试场景需显式 `delete process.env.NODE_ENV`。

## 相关场景

- [config.md](./config.md) — 配置文件字段
- [init.md](./init.md) — 项目初始化
