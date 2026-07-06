---
name: "npm-empty-publish"
description: "发布 0.0.0-canary.0 空包到 npm 占位,以便为 @faapi/<name> 包配置 Trusted Publisher (OIDC)。Invoke when npm 包不存在导致无法配置 Trusted Publisher,或用户说'发布空包'/'占位发布'/'配置 Trusted Publisher'。"
---

# npm 空包占位发布

本流程发布一个最小空包到 npm,让 `@faapi/<name>` 包"存在"于 npm,从而可以在包设置中配置 Trusted Publisher (OIDC),后续 CI 才能以 Trusted Publisher 方式自动发布 canary/正式版。

## 何时使用

- 用户说"配置 Trusted Publisher"、"npm 包不存在无法配置"、"发布空包占位"
- `@faapi/<name>` 包在 npm 上不存在(404),需要先发布占位版本
- CI canary 发布失败,报 403 Forbidden / ENEEDMFA,原因是 Trusted Publisher 未配置(前提是包不存在)

## 不适用场景

- 新增 monorepo 子包结构(参照 [AGENTS.md 6.5](file:///Users/tu/workspace/github/faapi/AGENTS.md) "新增子包配置清单")
- 正式版发布(用 `npm-stable-release` skill)
- DDD 开发某个模块(用 `ddd` skill)
- 包已存在且 Trusted Publisher 已配置(直接走 CI canary)

## 背景

npm Trusted Publisher (OIDC) 要求包已存在才能配置。新包首次发布前,需手动发布一个 `0.0.0-canary.0` 占位版本,让包"存在"于 npm,然后才能在包设置中添加 Trusted Publisher 记录。配置完成后,CI 才能 Trusted Publisher 方式自动发布 canary 版本。

这与 monorepo 内 `packages/<name>/` 的正式包结构创建是**两个独立步骤**:
- 本 skill:仅在 npm 上创建占位包,不涉及 monorepo
- AGENTS.md 6.5:在 monorepo `packages/<name>/` 下创建正式包结构

## 前置确认

向用户收集以下信息(若未提供则询问):

| 信息 | 用途 | 示例 |
|------|------|------|
| 包名 `<name>` | `@faapi/<name>`、临时目录名 | `redis`、`graphql` |
| npm 账号是否已登录 | 决定是否需要 `npm login` | 是/否 |
| OTP 码 | 双因素认证发布 | 6 位数字 |

**前提**:当前 npm 账号必须是 `@faapi` scope 的 owner 或 maintainer,否则无权发布。

## 流程

### 1. 检查包是否已存在

```bash
npm view @faapi/<name>
```

- **返回包信息** → 包已存在,跳过步骤 2-5,直接进入步骤 6 配置 Trusted Publisher
- **返回 404** → 包不存在,继续步骤 2

### 2. 创建临时空包目录

在 `/tmp/npm-empty-publish-<name>/` 下创建临时目录(不污染 monorepo):

```
/tmp/npm-empty-publish-<name>/
├── package.json
└── README.md
```

用 `LS` 确认目录不存在,然后创建。

### 3. `package.json`

```json
{
  "name": "@faapi/<name>",
  "version": "0.0.0-canary.0",
  "description": "Placeholder for Trusted Publisher setup. Real content published via CI from https://github.com/faapi/faapi.",
  "type": "module",
  "main": "./index.js",
  "files": [],
  "publishConfig": {
    "access": "public"
  }
}
```

**关键约束**(违反会导致发布失败):

| 字段 | 要求 | 原因 |
|------|------|------|
| `version` | 固定 `0.0.0-canary.0` | 与 monorepo 一致,后续 CI canary 会以 `0.0.0-canary.<hash>` 覆盖 |
| `publishConfig.access` | `public` | `@faapi` 是 scoped 包,默认 restricted,需显式 public |
| `publishConfig.provenance` | **不要设置** | 手动发布无 OIDC,设置 provenance 会发布失败 |
| `files` | `[]` | 不发布任何源码文件,仅 package.json + README |

### 4. `README.md`

npm 强制要求 README,最小占位:

```markdown
# @faapi/<name>

Placeholder package for Trusted Publisher setup. Real content published via CI from https://github.com/faapi/faapi.
```

### 5. 登录并发布空包

```bash
# 进入临时目录
cd /tmp/npm-empty-publish-<name>

# 登录(如未登录)
npm login

# 发布(带 OTP)
npm publish --otp <OTP>
```

**注意事项**:

- **不带 `--provenance`**:手动发布无 OIDC,带此参数会失败
- **不带 `--tag canary`**:默认发布到 `latest` tag。这是预期的——后续 CI canary 发布时会发布到 `canary` tag,正式版发布会覆盖 `latest`
- 发布成功后,空包版本 `0.0.0-canary.0` 会保留在 npm 版本历史中(用户已确认不 unpublish)

### 6. 配置 Trusted Publisher

向用户输出提示,引导其到 npm 网站配置:

```
⚠️ 手动配置 npm Trusted Publisher(首次发布前必做):

1. 登录 https://www.npmjs.com
2. 进入 @faapi/<name> 包页面 → Settings → Publishing access → Trusted Publishers → Add
3. 填写:
   - Repository owner: faapi
   - Repository name: faapi
   - Workflow filename: .github/workflows/release.yml
   - Environment: 留空
4. 保存

未配置会导致 CI canary job 报 403 Forbidden 或 ENEEDMFA。
```

### 7. 验证

```bash
# 确认包已发布
npm view @faapi/<name>

# 确认版本
npm view @faapi/<name> version
# 预期:0.0.0-canary.0
```

Trusted Publisher 配置需用户在 npm 网页确认。

### 8. 后续

- 在 monorepo 的 `packages/<name>/` 下按 [AGENTS.md 6.5](file:///Users/tu/workspace/github/faapi/AGENTS.md) "新增子包配置清单" 创建正式包结构
- 加入 `.changeset/config.json` 的 fixed 数组
- 创建初始 changeset(`.changeset/<name>-init.md`,声明 `major`)
- push 到 main 触发 CI canary job,自动以 `0.0.0-canary.<hash>` 发布到 npm `canary` tag
- 空包版本 `0.0.0-canary.0` 保留在 npm 版本历史中,无需 unpublish

## 异常处理

### `npm publish` 失败:ENEEDMFA / E401 Unauthorized

**原因**:未登录或 OTP 错误。

**处理**:
1. `npm whoami` 确认登录状态
2. 未登录则 `npm login`
3. OTP 错误则重新输入(`npm publish --otp <新OTP>`)

### `npm publish` 失败:E403 You do not have permission to publish

**原因**:当前 npm 账号不是 `@faapi` scope 的 owner 或 maintainer。

**处理**:联系 `@faapi` scope owner 在 npm 网站添加 maintainer 权限。

### `npm publish` 失败:E409 version already exists / EEPVERSION

**原因**:该版本号已发布过,包已存在。

**处理**:包已存在,跳过空包发布,直接进入步骤 6 配置 Trusted Publisher。

### CI canary 发布失败:403 Forbidden / ENEEDMFA(配置后仍失败)

**原因**:Trusted Publisher 配置字段与 workflow 不匹配。

**处理**:
1. 检查 npm 包 Settings → Trusted Publishers 是否存在记录
2. 确认 Repository owner=`faapi`、Repository name=`faapi`、Workflow filename=`.github/workflows/release.yml`、Environment 留空
3. 确认 `.github/workflows/release.yml` 的 canary job 有 `permissions: id-token: write`
4. 确认 monorepo 内 `packages/<name>/package.json` 的 `publishConfig.provenance: true`(注意:这是 CI 发布用的,与步骤 3 的空包 package.json 不同)

## 检查清单

发布空包占位完成前逐项确认:

- [ ] `npm view @faapi/<name>` 确认包状态(404 → 发布;已存在 → 跳过发布)
- [ ] 临时目录 `/tmp/npm-empty-publish-<name>/` 已创建
- [ ] `package.json` 字段正确(version=`0.0.0-canary.0`、无 provenance、access=public)
- [ ] `README.md` 已创建
- [ ] `npm login` 已完成(`npm whoami` 返回 faapi scope 账号)
- [ ] `npm publish --otp <OTP>` 成功
- [ ] `npm view @faapi/<name> version` 返回 `0.0.0-canary.0`
- [ ] 已提示用户到 npm 配置 Trusted Publisher(owner=faapi, repo=faapi, workflow=.github/workflows/release.yml)
- [ ] 已提示用户在 monorepo `packages/<name>/` 下按 AGENTS.md 6.5 创建正式包结构

## 参考资料

- [AGENTS.md 6.5.9 "npm 端手动配置"](file:///Users/tu/workspace/github/faapi/AGENTS.md) — Trusted Publisher 字段单一来源
- [AGENTS.md 7 "发布相关补充约定"](file:///Users/tu/workspace/github/faapi/AGENTS.md) — canary/正式版发布路径
- `npm-stable-release` skill — 正式版发布流程
- `.github/workflows/release.yml` — CI canary/stable workflow
