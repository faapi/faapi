---
name: "faapi-framework-dev"
description: "开发 faapi 框架本身。Invoke when 在 faapi 仓库内新增/修改框架功能、修框架 bug、新增 @faapi 子包、发 canary/正式版、处理业务方问题反馈（TODO-faapi-*.md），或需要理解框架架构时。"
---

# faapi 框架开发

## 何时使用

在 **faapi 仓库内开发框架本身**时使用：改 `packages/**/src` 源码、新增模块或子包、修框架 bug、发版、处理业务方反馈。

**边界**：用 faapi 框架开发业务应用的场景不归本技能管，走个人技能库的 `faapi-dev` 技能（不在本仓库）。

## 单一事实来源

项目级知识（架构、约定、交付定义、发布流程）只在项目根 `AGENTS.md` 维护，本技能只做场景编排，不复制内容。动手前先读 AGENTS.md 对应章节；模块级细节读 `packages/**/src` 下与代码同目录的 DDD 文档（如 `src/router/scanRoutes.md`）。

## 场景路由

| 用户意图 | 执行方式 | 依据 |
|---------|---------|------|
| 开发框架功能（新增/修改模块、改行为） | 走全局技能库的 `ddd` 技能（本仓库无本地副本，缺失时报错）：文档 → 测试 → 代码 → 通过，不跳过测试声明完成 | AGENTS.md「开发模式 / 文档体系」 |
| 理解架构 / dev·build·prod 链路 / 产物机制 | 读 AGENTS.md「架构」（统一产物驱动、零入口设计、按需编译），再按需读模块 DDD 文档 | AGENTS.md「架构」 |
| 新增 `@faapi/<name>` 子包 | 按 AGENTS.md「新增子包配置清单」逐项配置并跑完末节验证；npm 上包不存在时先用 `npm-empty-publish` 技能发占位包、配 Trusted Publisher | AGENTS.md「新增子包配置清单」 |
| 测试 / 质量门禁 | `pnpm -r run typecheck` / `lint` / `test` / `build`；本地快速反馈用包内 `test:unit`，提交前跑全量 | AGENTS.md「技术栈」/「新增子包配置清单·验证」 |
| 发 canary 版 | 打 `v{version}-canary.N` tag 推送，CI 以 Trusted Publisher（OIDC）自动发布到 npm `canary` tag | AGENTS.md「交付完成定义·发布相关补充约定」 |
| 发正式版 | 走 `npm-stable-release` 技能（changeset 升版本 + 打 tag） | AGENTS.md「交付完成定义·发布相关补充约定」 |
| 提交变更 | Conventional Commits（commitlint 强制）；`packages/faapi`、`packages/schema` 的用户可见变更必须随 PR 附 changeset（`pnpm changeset`），CHANGELOG 不手写 | AGENTS.md「交付完成定义」 |
| 用户可见变更（新能力 / 行为变化 / 配置字段） | 同步更新个人技能库 `faapi-dev`（cnb/skills 仓库 `skills/faapi-dev/`）对应场景文档及版本戳——属交付完成定义的一部分，不是可选项 | AGENTS.md「交付完成定义」 |
| 处理业务方问题反馈 | 见下方「业务方反馈处理」 | — |

## 业务方反馈处理

业务项目根目录的 `TODO-faapi-gaps.md`（功能缺口）/ `TODO-faapi-docs-fix.md`（文档错误）/ `TODO-faapi-bugs.md`(行为异常) 是框架问题的反馈通道，每条记录含：场景 + 源码依据（文件+行号）+ 期望 + 实际 + 变通。处理流程：

1. **先验证真伪**——按记录里的「源码依据」读 `packages/faapi/src/**` 源码（不是 dist 产物）复现最小用例。业务方可能误判（把用法错误、项目侧覆盖当框架问题），确认分类后再动手
2. 确认后按分类处理：行为异常 / 功能缺口走 `ddd` 技能修复；文档错误直接修正对应 DDD 文档或 AGENTS.md
3. 修复需验证：`grep` 确认行为 + `pnpm -r run typecheck` + `test` 全过，再按上一节附 changeset / 发版
4. 告知用户在业务项目侧删除对应 TODO 条目（或整个文件）
