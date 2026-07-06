---
name: "ddd"
description: "Documentation-Driven Development workflow: Doc → Test → Code → Pass. Invoke when user wants to develop features with documentation-first approach or mentions DDD/TDD with documentation."
---

# 文档驱动开发 (Documentation-Driven Development)

## 概述

工作流程：**文档 → 测试 → 代码 → 测试通过**

核心理念：
- **文档**：告诉 AI 这个功能是干什么的，不用读代码
- **测试**：定义功能的精确行为
- **代码**：完整实现功能，不留半成品，不使用临时方案

## 实现完整性原则（硬性约束）

**禁止事项**——以下情况视为实现未完成，不得声明"完成"或进入下一步：

1. **禁止临时方案**：不得使用 `TODO`/`FIXME`/`XXX`/`HACK` 等标记占位，不得写"暂时这样""后续再改"等注释。
2. **禁止桩函数**：不得返回硬编码假数据、空实现、`throw new Error('not implemented')`，除非测试明确要求该行为。
3. **禁止降级放行**：遇到暂不支持的语法/场景必须显式抛错（参考 AGENTS.md §6.3），不得静默降级为 `any` 或返回兜底值让流程"看起来通过"。
4. **禁止跳过测试**：不得注释/跳过/`it.skip`/`expect.any`/`todo` 等方式规避失败用例；失败的测试必须修复实现，不得修改测试迁就实现。
5. **禁止假通过**：不得通过修改测试期望值、放宽断言、`expect.anything()` 等方式让测试"假绿"。
6. **禁止依赖未实现项**：代码不得引用尚未创建的模块/函数/导出，或依赖"将来会有人实现"的接口。

**完成判定**：只有当所有测试真实通过、无 TypeScript 编译错误、无上述禁止项时，才算实现完成。任何一项不满足，必须继续实现或明确上报阻塞，不得含糊收尾。

## 工作流程

```
┌─────────────────────────────────────────────────────────────┐
│                    DDD 工作流程                              │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. 编写文档 ──→ 2. 编写测试 ──→ 3. 编写代码 ──→ 4. 测试通过  │
│       │              │              │              │        │
│       ▼              ▼              ▼              ▼        │
│   说明用途       定义行为       实现行为       确认完成      │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## 文件组织

**三个文件放在同一目录**：

```
src/utils/
├── normalizePath.md       # 文档：这个功能是干什么的
├── normalizePath.test.ts  # 测试：精确的行为定义
└── normalizePath.ts       # 代码：实现
```

---

## 执行步骤

### 第一步：编写文档

**目标**：让 AI 理解这个功能是干什么的，不用读代码。

**文档内容**：
1. **一句话概括** - 这个功能是什么
2. **为什么需要** - 解决什么问题
3. **使用场景** - 什么时候用它
4. **相关模块** - 和哪些模块有关系

**文档模板**：
```markdown
# <功能名称>

一句话概括：这个功能是什么。

## 为什么需要

<这个功能解决什么问题，为什么要有它>

## 使用场景

<什么时候会用到这个功能，典型场景是什么>

## 相关模块

<和哪些模块有依赖或协作关系>
```

**验收标准**：
- [ ] 能一句话说清楚功能是什么
- [ ] 说明了为什么需要
- [ ] 列出了使用场景

---

### 第二步：编写测试

**目标**：定义功能的精确行为。

**测试文件**：`<feature>.test.ts`（与文档同目录）

**测试模板**：
```typescript
import { describe, it, expect } from 'vitest';
import { <functionName> } from './<functionName>';

describe('<functionName>', () => {
  it('正常情况：...', () => {
    expect(<functionName>(...)).toBe(...);
  });

  it('边界情况：...', () => {
    expect(<functionName>(...)).toBe(...);
  });

  it('错误情况：...', () => {
    expect(() => <functionName>(...)).toThrow();
  });
});
```

**验收标准**：
- [ ] 测试文件与文档同目录
- [ ] 覆盖正常、边界、错误情况
- [ ] 此时测试应该失败（功能未实现）

---

### 第三步：编写代码

**目标**：实现功能，使测试通过。

**代码文件**：`<feature>.ts`（与文档同目录）

**验收标准**：
- [ ] 代码文件与文档同目录
- [ ] 所有测试通过
- [ ] 实现完整：无 `TODO`/`FIXME`/`HACK` 标记，无桩函数，无"后续再改"注释
- [ ] 不降级放行：暂不支持的场景显式抛错，不静默兜底
- [ ] 不依赖未实现项：所有引用的模块/函数均已真实存在

---

### 第四步：测试通过

```bash
pnpm test <feature>.test.ts
```

**验收标准**：
- [ ] 所有测试通过
- [ ] 无 TypeScript 编译错误

---

## 完整示例

### 任务：实现 `normalizePath` 函数

#### 文件结构

```
src/utils/
├── normalizePath.md
├── normalizePath.test.ts
└── normalizePath.ts
```

---

#### Step 1: 编写文档

**文件**：`src/utils/normalizePath.md`

```markdown
# normalizePath

一句话概括：将各种格式的路径字符串标准化为统一的 URL 路径格式。

## 为什么需要

在文件系统路由中，路径来源多样：
- 用户输入可能缺少前导斜杠
- Windows 系统使用反斜杠
- 可能存在重复斜杠或尾部斜杠

路由匹配需要统一的路径格式，否则 `/user/login` 和 `user/login` 会被视为不同路径。

## 使用场景

- 文件路径转 URL 路径时
- 路由匹配前标准化路径
- 处理跨平台路径差异

## 相关模块

- `parseRouteFile.ts` - 调用此函数标准化路由路径
- `matchRoute.ts` - 依赖标准化的路径进行匹配
```

---

#### Step 2: 编写测试

**文件**：`src/utils/normalizePath.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { normalizePath } from './normalizePath';

describe('normalizePath', () => {
  it('添加前导斜杠', () => {
    expect(normalizePath('user/login')).toBe('/user/login');
  });

  it('保持已有前导斜杠', () => {
    expect(normalizePath('/user/login')).toBe('/user/login');
  });

  it('去除尾部斜杠', () => {
    expect(normalizePath('/user/login/')).toBe('/user/login');
  });

  it('去除重复斜杠', () => {
    expect(normalizePath('/user//login')).toBe('/user/login');
  });

  it('反斜杠转正斜杠', () => {
    expect(normalizePath('\\user\\login')).toBe('/user/login');
  });

  it('空字符串返回空', () => {
    expect(normalizePath('')).toBe('');
  });
});
```

---

#### Step 3: 编写代码

**文件**：`src/utils/normalizePath.ts`

```typescript
/**
 * 标准化路径字符串
 */
export function normalizePath(path: string): string {
  if (!path) return '';

  let result = path.replace(/\\/g, '/');
  result = result.replace(/\/+/g, '/');
  result = result.replace(/\/+$/, '');

  if (result && !result.startsWith('/')) {
    result = '/' + result;
  }

  return result;
}
```

---

#### Step 4: 测试通过

```bash
pnpm test normalizePath.test.ts

✓ normalizePath > 添加前导斜杠
✓ normalizePath > 保持已有前导斜杠
✓ normalizePath > 去除尾部斜杠
✓ normalizePath > 去除重复斜杠
✓ normalizePath > 反斜杠转正斜杠
✓ normalizePath > 空字符串返回空

Test Files  1 passed
Tests       6 passed
```

---

## 三种文件的职责

| 文件 | 职责 | 回答的问题 |
|------|------|-----------|
| `.md` | 功能说明 | 这个功能是干什么的？为什么需要？ |
| `.test.ts` | 行为定义 | 输入什么返回什么？边界怎么处理？ |
| `.ts` | 实现 | 怎么实现？ |

**文档不重复测试的内容**：
- 输入输出规格 → 测试定义
- 边界情况 → 测试定义
- 错误处理 → 测试定义

**文档写测试无法表达的**：
- 业务背景
- 使用场景
- 模块关系

---

## 检查清单

| 步骤 | 检查项 | 状态 |
|------|--------|------|
| 文档 | 一句话概括功能 | ☐ |
| 文档 | 说明为什么需要 | ☐ |
| 文档 | 列出使用场景 | ☐ |
| 文档 | 不重复测试内容 | ☐ |
| 测试 | 与文档同目录 | ☐ |
| 测试 | 定义精确行为 | ☐ |
| 代码 | 与文档同目录 | ☐ |
| 代码 | 测试全部通过 | ☐ |
| 代码 | 无 TODO/FIXME/HACK 标记，无桩函数 | ☐ |
| 代码 | 暂不支持场景显式抛错，不降级放行 | ☐ |
| 代码 | 不引用未实现的模块/函数 | ☐ |
| 代码 | 未通过修改测试/放宽断言让用例"假绿" | ☐ |

---

## 文档的价值

**为什么需要文档层？**

| 没有 .md | 有 .md |
|----------|--------|
| AI 需要读代码理解功能 | AI 直接看文档理解 |
| AI 需要推断使用场景 | AI 明确知道何时使用 |
| AI 需要分析依赖关系 | AI 直接看相关模块 |

**文档让 AI 快速理解功能，无需解析代码。**
