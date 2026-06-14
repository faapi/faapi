# inputType

一句话概括：根据 HTTP 方法判断主输入类型（query 还是 body），以及方法是否可能有请求体。

## 为什么需要

faapi 的类型校验和依赖注入需要知道每个 HTTP 方法的主输入来源：GET/DELETE/HEAD 的主输入是 query 参数，POST/PUT/PATCH 的主输入是 body。`inputType` 将这一约定封装为可复用的函数，避免多处重复判断逻辑。

## 使用场景

- `generateSchema` 提取 schema 时，根据方法确定要校验的参数类型（query/body）
- `resolveInput` 解析请求输入时，根据方法决定读取 query 还是 body
- `schemaName` 生成存储 key 时，需要 inputType 组合方法名

## API

| 方法 | 说明 |
|------|------|
| `getInputTypeForMethod(method)` | 返回主输入类型：GET/DELETE/HEAD → `'query'`，其余 → `'body'` |
| `hasBody(method)` | 判断方法是否可能有请求体：POST/PUT/PATCH/DELETE → `true`，GET/HEAD → `false` |

### 方法分类

| 方法 | 主输入 | 可能有 body |
|------|--------|-------------|
| GET | query | 否 |
| HEAD | query | 否 |
| DELETE | query | 是 |
| POST | body | 是 |
| PUT | body | 是 |
| PATCH | body | 是 |

## 相关模块

- [cli/generateSchema.ts](../cli/generateSchema.md) - 用 `getInputTypeForMethod` 确定提取哪个参数的 schema
- [runtime/resolveInput.ts](../runtime/resolveInput.ts) - 用 `getInputTypeForMethod` 和 `hasBody` 解析请求输入
- [validator/schemaName.ts](../validator/schemaName.ts) - 用 `getInputTypeForMethod` 生成 schema 存储 key
