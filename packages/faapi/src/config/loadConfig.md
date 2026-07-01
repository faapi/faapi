# loadConfig

一句话概括：查找并加载 faapi 配置文件，支持多环境深度合并。

## 为什么需要

faapi 支持通过 `faapi.config.ts` 统一配置响应格式、错误处理、生命周期钩子、中间件等。不同环境（开发/测试/生产）通常需要不同配置。`loadConfig` 封装了配置文件查找、环境识别、深度合并、TypeScript 编译的逻辑，让 CLI 和 server 启动时获得最终配置对象。

## 使用场景

- `faapi` / `faapi dev` 启动时加载配置
- `faapi start` 启动时加载配置
- `--config` 参数指定配置文件路径
- `faapi.config.production.ts` 覆盖生产环境配置

## API

| 方法 | 说明 |
|------|------|
| `loadConfig(rootDir, configPath?)` | 加载并合并配置文件，返回 `Partial<FaapiConfig> \| null` |

### 查找顺序

1. 指定 `configPath` 时：直接加载该文件（不存在则抛错）
2. 未指定时：依次查找 `faapi.config.ts`、`faapi.config.js`（基础配置）
3. 找到基础配置后：按当前环境查找 `faapi.config.{env}.ts`、`faapi.config.{env}.js`（环境覆盖）

### 环境识别

优先级：`FAAPI_ENV` → `NODE_ENV` → `'development'`

`FAAPI_ENV` 优先：让 faapi 的环境切换不污染全局 `NODE_ENV`（其他库也读 `NODE_ENV`）。`FAAPI_ENV` 未设时回退 `NODE_ENV`，符合 Node 生态默认直觉。

注意：`NODE_ENV`/`FAAPI_ENV` 仅用于加载环境配置文件，**不再用于切换 dev/prd 启动模式**。启动模式由命令词决定（`faapi` = dev，`faapi start` = prd）。

### TypeScript 配置文件加载

`.ts` 配置文件由 esbuild 编译为临时 `.mjs` 后 import：

- **bundle: true**：跟随 import 链，本地相对导入（如 `import { base } from './base'`）会被打包进来
- **packages: 'external'**：第三方依赖与 `@faapi/*` 保持 external，从用户 `node_modules` 解析
- **内容哈希缓存**：产物路径基于源文件内容 SHA-1 哈希，同一文件内容未变化时跳过编译
- **临时目录**：产物写入 `os.tmpdir()/faapi-config/`，不污染用户项目
- `.js` / `.mjs` 配置文件直接 import，不走 esbuild

### 深度合并规则

环境配置与基础配置深度合并，环境配置优先：

- 普通对象递归合并
- `Date` / `RegExp` / `Map` / `Set` / 数组 / 函数：直接替换，不递归合并

## 相关模块

- [config/configTypes.ts](./configTypes.ts) - `FaapiConfig` 类型定义
- [utils/importWithCacheBust.ts](../utils/importWithCacheBust.ts) - 动态 import 与 ESM 缓存绕过
