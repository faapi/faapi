# coerceInput

一句话概括：根据类型信息将输入值做类型转换（coerce），主要解决 query/params 来源值全是 string 的问题。

## 为什么需要

URL query 参数和路由 params 的值在 HTTP 协议下总是 string，但 handler 声明的类型可能是 `number` 或 `boolean`。如果不做类型转换，校验器会因类型不匹配而报错，handler 也拿不到正确类型的值。`coerceInput` 在校验前先根据 schema 中的类型声明做转换，让用户无需手动 `Number(query.page)`。

## 使用场景

- 请求输入校验前，对 query/params 做类型转换
- `page=1` → `page: 1`（string → number）
- `active=true` → `active: true`（string → boolean）
- 数组字段逐元素转换
- 嵌套对象递归转换

## API

| 方法 | 说明 |
|------|------|
| `coerceInput(input, properties)` | 根据 `PropertyType` 列表对输入值做类型转换，返回 `{ data, issues }` |

### CoerceResult

| 字段 | 说明 |
|------|------|
| `data` | 转换后的数据 |
| `issues` | 转换失败的字段列表（`ValidationIssue[]`） |

## 转换规则

| 源类型 → 目标类型 | 规则 | 失败处理 |
|-------------------|------|----------|
| string → number | `Number()` 转换，NaN 视为失败 | 记录 issue，保留原值 |
| string → boolean | `'true'`/`'1'` → true，`'false'`/`'0'` → false | 记录 issue，保留原值 |
| string → string | 不转换 | — |
| string → 数值字面量 | `Number()` 转换（用于数值枚举 query 参数） | 不匹配则保留原值,由 validator 报错 |
| 数组 | 逐元素递归转换 | — |
| 元组 | 按位置递归转换 | — |
| 联合类型 | 尝试每个成员，返回第一个成功的 | 全部失败则保留原值 |
| 嵌套对象 | 递归转换属性 | — |
| 其他类型 | 不转换 | — |

### 数值字面量 coerce 说明

数值枚举（如 `enum Code { OK = 200 }`）在 AST 提取后变成字面量联合（`200 \| 404`）。
query 参数 `?code=200` 的值是字符串 `'200'`,直接和数值字面量 `200` 比较会失败。
因此 coerce 阶段对数值字面量尝试 `Number()` 转换,转换后由 validator 检查是否匹配字面量值。

## 相关模块

- [validator/validateInput.ts](./validateInput.ts) - 校验前调用 `coerceInput` 做类型转换
- [ast/resolveTypeNode.ts](../ast/resolveTypeNode.ts) - `RuntimeType` / `PropertyType` 类型定义
- [errors/httpErrors.ts](../errors/httpErrors.ts) - `ValidationIssue` 类型定义
