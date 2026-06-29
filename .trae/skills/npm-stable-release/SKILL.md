---
name: "npm-stable-release"
description: "发布 npm 正式版,通过 changeset 升版本号 + 打 tag 触发 CI OIDC 自动发布。Invoke when 用户要发布正式版/stable 版本/打 tag 发版,或提到 release/正式发布时。"
---

# npm 正式版发布流程

本流程用于发布 faapi monorepo 的正式版到 npm。通过 changeset 管理版本号,打 tag 触发 GitHub Actions OIDC 自动发布。

## 适用场景

- 用户说"发正式版"、"发布 stable 版本"、"打 tag 发版"
- 累积了若干 changeset,准备发版
- canary 版本验证通过,需要发布到 `latest` tag

## 前置条件

- 已在 main 分支
- 上一次 canary 版本在 npm 上验证通过

## 流程

### 1. 前置检查

```bash
# 确认在 main 分支
git rev-parse --abbrev-ref HEAD
# 应输出: main
```

**若不在 main 分支则中止**,提示用户先切到 main。

### 2. 处理 working tree

```bash
git status --porcelain
```

#### 情况 A:working tree 干净

继续步骤 3。

#### 情况 B:working tree 脏

分析未提交改动:

```bash
git diff --stat
git diff --cached --stat
```

**判断处理方式**:

- 若是未提交的功能/修复改动 → 提示用户:"有未提交改动,请先 commit 或 stash。是否提交?"(用户确认后 commit,message 按改动内容生成,如 `chore: WIP before release` 或具体描述)
- 若是构建产物(`dist/`)或临时文件 → 可安全 checkout 丢弃:
  ```bash
  git checkout -- packages/*/dist
  ```
- 若是版本号/CHANGELOG 残留(上次发版失败导致) → 提示用户确认后 reset:
  ```bash
  git reset --hard HEAD
  ```

**禁止自动 commit 用户未确认的改动**,必须询问用户。

### 3. 验证 canary 版本

发正式版前,先验证最新 canary 版本是否可用:

```bash
# 获取最新 canary 版本号
CANARY_VERSION=$(npm view @faapi/faapi dist-tags --json | node -p "JSON.parse(require('fs').readFileSync(0))?.canary || ''")

if [ -z "$CANARY_VERSION" ]; then
  echo "No canary version found. Skip canary verification."
else
  echo "Latest canary: $CANARY_VERSION"
fi
```

#### 验证 canary 安装与运行

```bash
# 临时目录验证
TMPDIR=$(mktemp -d)
cd "$TMPDIR"

# 初始化并安装 canary 版本
npm init -y > /dev/null 2>&1
npm install @faapi/faapi@$CANARY_VERSION @faapi/schema@$CANARY_VERSION @faapi/next@$CANARY_VERSION > /dev/null 2>&1

# 验证 CLI 可运行
npx faapi --version 2>&1 || echo "CLI check failed"

# 验证主包可导入
node -e "import('@faapi/faapi').then(m => console.log('faapi exports:', Object.keys(m).slice(0,5)))" 2>&1

# 验证 schema 包可导入
node -e "import('@faapi/schema').then(m => console.log('schema default export:', typeof m.default))" 2>&1

# 验证 next 包可导入
node -e "import('@faapi/next').then(m => console.log('next exports:', Object.keys(m).length > 0))" 2>&1

cd - > /dev/null
rm -rf "$TMPDIR"
```

**验证失败处理**:
- CLI 无法运行 → 中止发版,提示用户修复 canary 后重试
- 导入失败 → 中止发版,提示用户检查构建产物
- canary 版本不存在 → 警告但继续(可能是首次发版)

### 4. 确保 pending changeset 存在

检查 `.changeset/` 目录下是否有 pending changeset 文件(除 README.md):

```bash
ls .changeset/*.md 2>/dev/null | grep -v README.md
```

#### 情况 A:有 pending changeset

继续步骤 5。

#### 情况 B:无 pending changeset — 自动生成

##### 4.1 分析改动

读取自上次发版 tag 以来的改动:

```bash
# 找到最近的 v* tag
LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")

# 查看改动统计
if [ -n "$LAST_TAG" ]; then
  git log --oneline "$LAST_TAG"..HEAD
  git diff "$LAST_TAG"..HEAD --stat
else
  git log --oneline -20
  git diff HEAD~20..HEAD --stat
fi
```

读取关键文件的 diff,理解改动内容:
- `packages/faapi/src/index.ts` — 公开导出变更
- `packages/faapi/src/**/*.ts` — 主包改动
- `packages/schema/src/index.ts` — schema 公开导出变更
- `packages/schema/src/**/*.ts` — schema 包改动
- `AGENTS.md` — 架构/约定变更(可能影响 major)

##### 4.2 判断 bump type(客观规则表)

基于改动内容,按以下规则表判断:

| 改动类型 | bump type | 判断依据 |
|---------|----------|---------|
| 删除/重命名公开导出 | major | `src/index.ts` 中 export 被删除或改名 |
| 加必填参数/字段 | major | 公开 API 签名变更,旧代码不兼容 |
| 改必填参数为可选 | minor | 向后兼容,旧代码仍可用 |
| 新增公开导出 | minor | `src/index.ts` 中新增 export |
| 新增配置字段 | minor | `FaapiConfig` / `FaapiContext` 接口新增字段 |
| 新增可选参数/字段 | minor | 向后兼容 |
| 修复 bug(行为变更,API 不变) | patch | 修了错误行为,API 签名不变 |
| 重构(无行为变更) | none | 代码结构调整,运行时行为不变 |
| 性能优化(无行为变更) | none | 仅性能提升,行为不变 |
| 文档/测试/注释 | none | 不影响运行时 |

**多类改动混合时,取最高 bump type**(major > minor > patch > none)。

**特殊情况**:
- 改了 `@faapi/faapi` / `@faapi/schema` / `@faapi/next` 中的任意一个或多个 → 因 `fixed` 配置,三个包都标同一个 bump type
- 只改了 `@faapi/schema`(或 `@faapi/next`) → 仍然三个包都标(因 `fixed` 配置强制同步)
- 改动只在 devDependencies → none(不影响运行时)

##### 4.3 判断影响的包

- 改动 `packages/faapi/src/**` → `@faapi/faapi`
- 改动 `packages/schema/src/**` → `@faapi/schema`
- 改动 `packages/next/src/**` → `@faapi/next`
- 多个都改 → 实际影响的包都标

**因 `fixed` 配置,实际会取最高 bump type 同步升级三个包**,但 changeset 文件里仍按实际影响的包标注。

##### 4.4 询问用户确认

向用户展示分析结果,询问确认:

```
基于 git diff 分析:
- 影响包: @faapi/faapi, @faapi/schema, @faapi/next
- 建议 bump type: minor (新增了 xxx 功能,导出了 xxx)
- 变更描述: <自动生成的简短描述>

是否确认?(可调整 bump type 或描述)
```

**用户可调整**:
- bump type(如认为应该是 patch 而非 minor)
- 变更描述(如想写更详细的 CHANGELOG)

##### 4.5 生成 changeset 文件

用户确认后,生成 `.changeset/<描述性文件名>.md`:

```markdown
---
"@faapi/faapi": <bump_type>
"@faapi/schema": <bump_type>
"@faapi/next": <bump_type>
---

<变更描述,会写入 CHANGELOG>
```

**文件名**:用简短英文描述,如 `plugin-system.md`、`bugfix-injection.md`。

**格式约束**:
- frontmatter 的 key 是包名(带引号)
- value 是 bump type(`patch`/`minor`/`major`)
- `---` 之间是 YAML frontmatter
- 之后是 markdown 格式的变更描述

**若 bump type 为 none**:不生成 changeset 文件,提示用户"改动不需要发版",结束流程。

##### 4.6 提交 changeset

```bash
git add .changeset/<filename>.md
git commit -m "chore: add changeset for <描述>"
```

继续步骤 5。

### 5. 记录当前版本

```bash
node -p "require('./packages/faapi/package.json').version"
```

记录为 `OLD_VERSION`,用于后续验证版本号是否真的升级了。

### 6. 运行 changeset version

```bash
pnpm changeset version
```

此命令会:
- 消费 `.changeset/*.md` 文件(除 README.md)
- 根据 changeset 的 bump type(patch/minor/major)计算新版本号
- 更新 `packages/*/package.json` 的 version 字段
- 更新 `packages/*/CHANGELOG.md`
- 删除已消费的 changeset 文件

**fixed 配置保证三包版本同步**:即使 changeset 只标记其中一个包,[.changeset/config.json](file:///Users/tu/workspace/github/faapi/.changeset/config.json) 的 `fixed: [["@faapi/faapi", "@faapi/schema", "@faapi/next"]]` 会让三个包版本号保持一致(取最高 bump type)。

### 7. 验证版本升级

```bash
# 读取新版本
node -p "require('./packages/faapi/package.json').version"
```

对比 `OLD_VERSION`,确认版本号已升级。若未变,说明 changeset 文件的 bump type 有问题,中止流程。

### 8. 验证三包版本同步

```bash
FAAPI_VERSION=$(node -p "require('./packages/faapi/package.json').version")
SCHEMA_VERSION=$(node -p "require('./packages/schema/package.json').version")
NEXT_VERSION=$(node -p "require('./packages/next/package.json').version")
```

三个版本必须一致(因 fixed 配置)。若不一致,中止流程并提示检查 changeset config。

### 9. 本地验证(发版前)

在打 tag 推送前,本地验证构建产物:

```bash
# 构建并验证
pnpm build

# typecheck 通过
pnpm typecheck

# 测试通过
pnpm test

# 验证构建产物可导入
node -e "import('./packages/faapi/dist/index.js').then(m => console.log('faapi OK:', Object.keys(m).length > 0))"
node -e "import('./packages/schema/dist/index.js').then(m => console.log('schema OK:', typeof m.default === 'object'))"
node -e "import('./packages/next/dist/index.js').then(m => console.log('next OK:', Object.keys(m).length > 0))"
```

**任一验证失败则中止**,提示用户修复后重试。

### 10. 提交版本升级

```bash
git add -A
git commit -m "release: v$NEW_VERSION"
```

提交内容包含:
- `packages/*/package.json` 版本号更新
- `packages/*/CHANGELOG.md` 更新
- 已消费的 changeset 文件删除

### 11. 打 tag

```bash
git tag "v$NEW_VERSION"
```

**tag 名格式**: `v` + 版本号(如 `v0.0.1`、`v1.2.3`),与 [release.yml](file:///Users/tu/workspace/github/faapi/.github/workflows/release.yml) 的 `tags: ['v*']` 匹配。

### 12. 推送触发 CI

```bash
git push origin main --tags
```

推送后 GitHub Actions 自动触发 stable job:
- `on.push.tags: ['v*']` 匹配 `v$NEW_VERSION` tag
- stable job 执行 `pnpm changeset publish`
- 通过 OIDC Trusted Publisher 发布到 npm,tag 为 `latest`

### 13. 验证发布(发版后)

CI 跑完后(约 2-3 分钟),完整验证:

```bash
# 1. 验证 npm 版本号
npm view @faapi/faapi version      # 应输出 NEW_VERSION
npm view @faapi/schema version     # 应输出 NEW_VERSION
npm view @faapi/next version       # 应输出 NEW_VERSION

# 2. 验证 dist-tags
npm view @faapi/faapi dist-tags    # latest 应指向 NEW_VERSION
npm view @faapi/schema dist-tags   # latest 应指向 NEW_VERSION
npm view @faapi/next dist-tags     # latest 应指向 NEW_VERSION

# 3. 验证安装(dry-run,不实际安装)
npm install @faapi/faapi@$NEW_VERSION --dry-run
npm install @faapi/schema@$NEW_VERSION --dry-run
npm install @faapi/next@$NEW_VERSION --dry-run

# 4. 验证运行(临时目录)
TMPDIR=$(mktemp -d)
cd "$TMPDIR"
npm init -y > /dev/null 2>&1
npm install @faapi/faapi@$NEW_VERSION @faapi/schema@$NEW_VERSION @faapi/next@$NEW_VERSION > /dev/null 2>&1

# 验证 CLI 可运行
npx faapi --version 2>&1

# 验证主包可导入
node -e "import('@faapi/faapi').then(m => console.log('faapi exports:', Object.keys(m).length > 0))"

# 验证 schema 包可导入
node -e "import('@faapi/schema').then(m => console.log('schema default:', typeof m.default === 'object'))"

# 验证 next 包可导入
node -e "import('@faapi/next').then(m => console.log('next exports:', Object.keys(m).length > 0))"

cd - > /dev/null
rm -rf "$TMPDIR"
```

CI 进度监控: https://github.com/faapi/faapi/actions

**验证失败处理**:
- 版本号未更新 → CI 可能还在跑,等待后重试
- 安装失败 → 检查 npm registry 是否同步,等待 30 秒重试
- CLI 无法运行 → 检查 `bin` 字段配置,可能需要发 patch 修复
- 导入失败 → 检查 `exports` 字段配置,可能需要发 patch 修复

## 版本号规则

版本号由 changeset 根据 bump type 计算,不是手动指定:

| changeset 选择 | 升级规则 | 示例 |
|---------------|---------|------|
| patch | 末位 +1 | 0.0.1 → 0.0.2 |
| minor | 中位 +1,末位归 0 | 0.0.1 → 0.1.0 |
| major | 首位 +1,中末位归 0 | 0.1.0 → 1.0.0 |

**fixed 配置**:三个包取所有 changeset 中最高的 bump type 同步升级。

## 异常处理

### 版本号未升级

**症状**:运行 `pnpm changeset version` 后版本号没变

**原因**:
- changeset 文件的 bump type 为 `none`
- 没有 pending changeset(被之前的发版消费掉了)

**处理**:回到步骤 4,重新生成 changeset,确认选了 patch/minor/major(不是 none)。

### 包版本不同步

**症状**:`@faapi/faapi` / `@faapi/schema` / `@faapi/next` 三者版本号不一致

**处理**:检查 [.changeset/config.json](file:///Users/tu/workspace/github/faapi/.changeset/config.json) 的 `fixed` 字段是否包含全部三个包。

### CI stable job 失败

**常见原因**:
- Trusted Publisher 未在 npm 网站配置(去 npm 包设置页检查)
- `permissions: id-token: write` 缺失(检查 release.yml)
- 包版本号已存在于 npm(版本号未升级,重复发布)

### tag 已存在

**症状**:`git tag v$VERSION` 报错 `tag already exists`

**处理**:
```bash
git tag -d "v$VERSION"           # 删本地 tag
git push origin :refs/tags/v$VERSION  # 删远程 tag
```
确认版本号正确后重新打 tag。**注意**:不要 force push tag,可能影响已发布的版本。

### canary 验证失败

**症状**:canary 版本 CLI 无法运行或导入失败

**处理**:
1. 中止发版流程
2. 提示用户:"canary 版本 $CANARY_VERSION 验证失败,请先修复"
3. 等待用户修复后重新触发发版流程

### 发版后验证失败

**症状**:npm 上的 latest 版本无法安装或运行

**处理**:
1. 如果是配置问题(bin/exports)→ 发 patch 版本修复
2. 如果是代码 bug → 修复后发 patch 版本
3. 如果版本号已存在无法重新发布 → 必须升版本号(如 0.0.1 → 0.0.2)

## 检查清单

发布前逐项确认:

- [ ] 当前在 main 分支
- [ ] working tree 干净(或已处理脏状态)
- [ ] canary 版本验证通过(或确认跳过)
- [ ] 至少一个 pending changeset 文件(或已通过步骤 4 自动生成)
- [ ] `pnpm changeset version` 后版本号升级
- [ ] 两个包版本号一致
- [ ] `pnpm build` 成功
- [ ] `pnpm typecheck` 通过
- [ ] `pnpm test` 通过
- [ ] 构建产物可导入
- [ ] commit message 格式 `release: v$VERSION`
- [ ] tag 名格式 `v$VERSION`
- [ ] 已 `git push origin main --tags`
- [ ] CI stable job 触发并成功
- [ ] `npm view` 验证版本号和 latest tag
- [ ] 安装验证通过(dry-run)
- [ ] 运行验证通过(CLI + 导入)
