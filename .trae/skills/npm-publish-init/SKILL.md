---
name: "npm-publish-init"
description: "初始化发布新 npm 包到 registry,完成首次手动发布。Invoke when 创建新包需要首次发布、或用户提到初始化包发布/首次发布 npm 包时。"
---

# npm 包初始化发布流程

本流程用于将新包首次发布到 npm registry。适用于 faapi monorepo 下的 `packages/*` 子包。

## 适用场景

- 新建 `packages/<name>` 子包,需要首次发布到 npm
- 用户提到"初始化包发布"、"首次发布 npm 包"
- 现有包从未发布过,需要完成首次发布

## 前置条件

- npm 账户已开启 2FA(双因素认证)
- 已登录 npm(`npm whoami` 能返回用户名)
- 包名在 npm registry 上未被占用(`npm view @scope/name` 返回 404)
- 本地代码已通过 `pnpm typecheck`、`pnpm lint`、`pnpm test`

## 流程

### 1. 准备 package.json

```json
{
  "name": "@faapi/<name>",
  "version": "0.0.0-canary.0",
  "description": "<包描述>",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "engines": {
    "node": ">=22"
  },
  "scripts": {
    "build": "tsup",
    "prepublishOnly": "pnpm build",
    "test": "vitest run --passWithNoTests",
    "typecheck": "tsc --noEmit"
  },
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/faapi/faapi.git",
    "directory": "packages/<name>"
  },
  "publishConfig": {
    "access": "public"
  }
}
```

**关键约束**:

| 字段 | 要求 | 原因 |
|------|------|------|
| `version` | 统一 `0.0.0-canary.0` | 预正式版本,不污染 `latest` tag |
| `publishConfig` | **不要**加 `provenance: true` | 本地无 OIDC 环境,会发布失败;CI 用 `--provenance` flag |
| `repository.url` | 与 git remote 一致 | npm 会规范化为 `git+https://...` |
| `exports` | `types` 与 `import` 平级 | 嵌套在 `import.types` 内会导致 tsup dts 解析失败 |

### 2. 本地构建

```bash
pnpm build
```

确认 `dist/` 产物生成,包含 `index.js`、`index.d.ts`、`index.js.map`。

### 3. 首次手动发布

```bash
cd packages/<name>
npm publish --access public --tag canary --otp <OTP码>
```

**关键点**:

- `--tag canary`:不污染 `latest` tag,标记为预发布版本
- **不加** `--provenance`:本地环境无 OIDC,会失败
- `--otp <OTP码>`:npm 2FA 认证码(6 位数字,30 秒有效)
- 若误设了 `publishConfig.provenance: true`,临时移除或追加 `--provenance false`

### 4. 验证发布

```bash
npm view @faapi/<name> version
```

返回 `0.0.0-canary.0` 即发布成功。若返回 404,等待 10 秒后重试(registry 同步延迟)。

## 处理误发布

### 场景:误将初始化版本发布为正式版

**症状**:`npm view @scope/name version` 返回 `0.0.1` 而非 `0.0.0-canary.0`

**处理**(72 小时内):

```bash
npm unpublish @scope/name --force --otp <OTP码>
```

修改 `package.json` 版本为 `0.0.0-canary.0`,重新执行发布流程。

### 场景:已发布版本需覆盖

npm 不允许重新发布已存在的版本号。若需"覆盖",只能:
1. 72 小时内:`npm unpublish` 删除整个包,重新发布
2. 超过 72 小时:只能发布更高版本号

## 检查清单

发布前逐项确认:

- [ ] `package.json` 的 `version` 为 `0.0.0-canary.0`
- [ ] `publishConfig` **未**设置 `provenance: true`
- [ ] `repository.url` 与 `git remote -v` 输出一致
- [ ] `exports` 字段 `types` 与 `import` 平级(不嵌套)
- [ ] `pnpm build` 成功,`dist/` 产物完整
- [ ] `npm view @scope/name` 返回 404(包名未被占用)
- [ ] OTP 码有效(30 秒内)
- [ ] 发布命令带 `--tag canary` 且**不带** `--provenance`
