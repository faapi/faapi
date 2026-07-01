---
name: "faapi-new-pkg"
description: "在 faapi monorepo 创建新子包(@faapi/<name>),按 AGENTS.md 6.5 配置完整文件结构、changeset、Trusted Publisher。Invoke when 用户要新增子包/创建 @faapi/xxx 包/添加扩展包时。"
---

# faapi 新增子包

本流程在 faapi monorepo 下创建新的 `@faapi/<name>` 子包,配置完整文件结构,确保通过 Trusted Publisher(COIDC)发布。

## 何时使用

- 用户说"新增子包"、"创建 `@faapi/xxx`"、"添加扩展包"
- 用户要在 `packages/` 下新建一个发布到 npm 的包

## 不适用场景

- 用户基于 faapi 开发应用(用 `faapi-dev` skill)
- 发布正式版(用 `npm-stable-release` skill)
- DDD 开发某个模块(用 `ddd` skill)

## 前置确认

向用户收集以下信息(若未提供则询问):

| 信息 | 用途 | 示例 |
|------|------|------|
| 包名 `<name>` | `@faapi/<name>`、目录名 | `redis`、`graphql` |
| 包描述 | package.json `description`、README 标题 | "Redis integration for faapi" |
| 是否依赖主包 | 决定 package.json/tsup/vitest 配置 | 是/否 |
| 第三方 peer 依赖(若有) | 加入 tsup external | `next`、`redis` |

## 流程

### 1. 创建目录结构

```
packages/<name>/
├── src/
│   └── index.ts
├── LICENSE            # MIT,从 packages/faapi/LICENSE 复制
├── README.md
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── vitest.config.ts
```

用 `LS` 确认 `packages/<name>` 不存在,然后逐文件创建。

### 2. `package.json`

```json
{
  "name": "@faapi/<name>",
  "version": "0.0.0-canary.0",
  "description": "<包描述>",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": { "types": "./src/index.ts", "import": "./src/index.ts" }
  },
  "engines": { "node": ">=24" },
  "files": ["dist"],
  "scripts": {
    "build": "tsup",
    "test": "vitest run --passWithNoTests",
    "typecheck": "tsc --noEmit"
  },
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/faapi/faapi.git",
    "directory": "packages/<name>"
  },
  "bugs": { "url": "https://github.com/faapi/faapi/issues" },
  "keywords": ["faapi", "...按包内容补充"],
  "sideEffects": false,
  "publishConfig": {
    "access": "public",
    "provenance": true,
    "main": "./dist/index.js",
    "types": "./dist/index.d.ts",
    "exports": {
      ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" }
    }
  }
}
```

**关键约束**(违反会导致发布失败):

| 字段 | 要求 | 原因 |
|------|------|------|
| `version` | 固定 `0.0.0-canary.0` | canary 阶段不递增,canary 版本由 CI 基于 git hash 生成 |
| `repository.directory` | `packages/<name>` | npm 包页面定位源码 |
| `publishConfig.provenance` | 必须为 `true` | 项目已切换到 Trusted Publisher(OIDC),无 provenance 无法通过 CI 发布 |
| `exports` 的 `types` 与 `import` | 平级,不嵌套 | 嵌套会导致 tsup dts 解析失败 |

**依赖主包时追加**:

```json
"dependencies": {
  "@faapi/faapi": "workspace:*"
}
```

**有第三方 peer 依赖时追加**(如 `next`):

```json
"peerDependencies": {
  "next": ">=13.0.0"
},
"peerDependenciesMeta": {
  "next": { "optional": true }
}
```

### 3. `tsconfig.json`(固定模板)

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src"]
}
```

含 e2e 测试时加 `"exclude": ["src/**/*.e2e.test.ts"]`,避免 tsc 检查 e2e 深路径导入。

### 4. `tsup.config.ts`

```ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  platform: 'node',
  external: ['node:*', '@faapi/faapi'],
});
```

`external` 至少包含 `node:*` 和 `@faapi/faapi`;有第三方 peer 依赖(如 `next`)一并加入。

### 5. `vitest.config.ts`

依赖主包时需配置 alias,测试时直接加载主包 src 源码:

```ts
import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@faapi/faapi/src': path.resolve(__dirname, '../faapi/src'),
      '@faapi/faapi': path.resolve(__dirname, '../faapi/src/index.ts'),
    },
  },
  test: {
    globals: true,
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['node_modules', 'dist'],
    testTimeout: 15000,
    fileParallelism: true,
    maxWorkers: '50%',
  },
});
```

E2E 测试含服务器启动时追加 `pool: 'forks'`(worker 线程易崩溃)。

不依赖主包时移除 `resolve.alias` 块。

### 6. `src/index.ts`

最小入口,按包职责导出。可先空导出占位:

```ts
// 包入口,后续按功能补充导出
export {};
```

### 7. `LICENSE`

从现有包的 LICENSE 文件复制(如 `packages/faapi/LICENSE`),MIT 协议,版权年份和持有者保持一致。

### 8. `README.md`

最小结构:

```markdown
# @faapi/<name>

<包描述>

## 安装

\`\`\`bash
pnpm add @faapi/<name>
\`\`\`

## 使用

<按包职责补充>
```

### 9. 更新 `.changeset/config.json` — 加入 fixed 数组

读取 `.changeset/config.json`,在 `fixed` 数组中加入新包名:

```json
"fixed": [["@faapi/faapi", "@faapi/schema", "@faapi/next", "@faapi/<name>"]]
```

fixed 模式强制所有包统一版本号,新增包必须加入此数组,否则发版时版本不同步。

### 10. 创建初始 changeset

创建 `.changeset/<name>-init.md`,声明 major 升级(首次发布):

```markdown
---
"@faapi/<name>": major
---

首次发布 @faapi/<name> —— <一句话描述包职责>

<按功能点列出初始能力>
```

**格式约束**:
- frontmatter 的 key 是包名(带引号),value 是 bump type
- 首次发布用 `major`
- 正文是 CHANGELOG 条目,写清楚初始能力

### 11. 提示 npm 端手动配置(无法自动化)

新包首次 canary 发布前,必须到 npm 网站配置 Trusted Publisher。向用户输出提示:

```
⚠️ 手动配置 npm Trusted Publisher(首次发布前必做):

1. 登录 https://www.npmjs.com
2. 创建包 @faapi/<name>(若不存在,首次 push 到 main 触发 canary 时会自动创建;也可手动 npm init 创建空包占位)
3. 进入包页面 → Settings → Publishing access → Trusted Publishers → Add
4. 填写:
   - Repository owner: faapi
   - Repository name: faapi
   - Workflow filename: .github/workflows/release.yml
   - Environment: 留空
5. 保存

未配置会导致 CI canary job 报 403 Forbidden 或 ENEEDMFA。
```

### 12. 验证

执行以下命令,全部通过才算配置完成:

```bash
# 链接 workspace
pnpm install

# 类型检查(递归所有包)
pnpm -r run typecheck

# Lint
pnpm lint

# 测试(新包无测试时 passWithNoTests)
pnpm -r run test

# 构建
pnpm -r run build
```

任一失败则修复对应文件。

### 13. 后续发版

新包不需要本地手动 `npm publish`。发版路径:

- **canary**:push 到 main,CI 自动以 `0.0.0-canary.<hash>` 发布到 npm `canary` tag
- **正式版**:累积 changeset 后,用 `npm-stable-release` skill 走 changeset version + tag 流程

## 异常处理

### CI canary 发布失败:403 Forbidden / ENEEDMFA

**原因**:npm 端未配置 Trusted Publisher,或配置字段与 workflow 不匹配。

**处理**:
1. 检查 npm 包 Settings → Trusted Publishers 是否存在记录
2. 确认 Repository owner=`faapi`、Repository name=`faapi`、Workflow filename=`.github/workflows/release.yml`
3. 确认 `.github/workflows/release.yml` 的 canary job 有 `permissions: id-token: write`
4. 确认 package.json 的 `publishConfig.provenance: true`

### CI canary 发布失败:版本已存在

**原因**:同一 git hash 重复触发,或版本号冲突。

**处理**:新 commit push 后重试(canary 版本号含 git hash,新 commit 会生成新版本号)。

### 三包版本不同步

**原因**:新包未加入 `.changeset/config.json` 的 `fixed` 数组。

**处理**:按步骤 9 补充 fixed 数组。

### 误发布处理

#### 场景:误将初始化版本发布为正式版

**症状**:`npm view @faapi/<name> version` 返回 `0.0.1` 而非 `0.0.0-canary.0`

**处理**(72 小时内):

```bash
npm unpublish @faapi/<name> --force --otp <OTP码>
```

修改 `package.json` 版本为 `0.0.0-canary.0`,重新走 CI canary 流程。

#### 场景:已发布版本需覆盖

npm 不允许重新发布已存在的版本号。若需"覆盖",只能:
1. 72 小时内:`npm unpublish` 删除整个包,重新发布
2. 超过 72 小时:只能发布更高版本号

## 检查清单

新增子包完成前逐项确认:

- [ ] `packages/<name>/` 目录已创建
- [ ] `package.json` 字段完整(version=`0.0.0-canary.0`、provenance=true、repository.directory 正确)
- [ ] `tsconfig.json` extends `../../tsconfig.base.json`
- [ ] `tsup.config.ts` external 含 `node:*` 和 `@faapi/faapi`
- [ ] `vitest.config.ts` alias 配置正确(依赖主包时)
- [ ] `src/index.ts` 存在
- [ ] `LICENSE` 已复制
- [ ] `README.md` 已创建
- [ ] `.changeset/config.json` 的 fixed 数组已加入 `@faapi/<name>`
- [ ] `.changeset/<name>-init.md` 已创建(major)
- [ ] `pnpm install` 成功
- [ ] `pnpm -r run typecheck` 通过
- [ ] `pnpm lint` 通过
- [ ] `pnpm -r run test` 通过
- [ ] `pnpm -r run build` 通过
- [ ] 已提示用户到 npm 配置 Trusted Publisher

## 参考资料

- AGENTS.md 6.5 "新增子包配置清单" — 单一来源,本 skill 是其执行版
- npm-stable-release skill — 正式版发布流程
- `.changeset/config.json` — fixed 配置(fixed 数组含所有包名)
- `.github/workflows/release.yml` — CI canary/stable workflow
