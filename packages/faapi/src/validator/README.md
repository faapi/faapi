# 输入校验

基于 TypeScript AST 生成运行时校验函数，实现"类型即校验"——用户只需定义 interface，框架自动生成校验逻辑。

## 模块

| 模块 | 说明 |
| --- | --- |
| [schemaRegistry.ts](./schemaRegistry.ts) | 校验函数注册表（单例）：统一管理校验函数，屏蔽 dev/prd 差异 |
| [validateInput.ts](./validateInput.ts) | 校验入口：查 registry → 类型转换 → 调用校验函数 |
| [coerceInput.ts](./coerceInput.ts) | 类型转换：string→number/boolean（仅 query 需要） |
| [schemaName.ts](./schemaName.ts) | schema 命名：`GET` + `query` → `GETQuery` |

## 架构

build 时将 RuntimeType 编译为校验函数 JS 代码，运行时直接调用，无需解释类型结构。

```
AST 提取 → RuntimeType → generateValidatorCode → 校验函数源码
                                                         ↓
                                          dev: .faapi/dev/faapi-schema.js 预生成
                                          prd: dist/faapi-schema.js 预生成
                                                         ↓
                                              schemaRegistry 注册（import 加载）
                                                         ↓
                                              validateInput 调用
```

## 校验函数来源

dev 和 prd 都通过 `schemaRegistry` 获取校验函数，不降级：

| 模式 | 校验函数来源 | 加载时机 |
| --- | --- | --- |
| dev | AST 提取 → 生成源码 → 写入 `.faapi/dev/faapi-schema.js` → import 加载 | 启动时全量，watch 时全量重建 |
| prd | `dist/faapi-schema.js` | 启动时 import 加载 |
| e2e/直接调用 | AST 自动提取 | createServer 发现 registry 为空时自动提取 |

三种状态：
- `ValidatorFn`：有类型声明，执行校验
- `null`：handler 无类型声明，跳过校验
- `undefined`：manifest 不完整，抛 InternalError

## 校验策略

```
schemaRegistry.get(filePath, schemaName)
  → 获取 ValidatorFn（从 registry 或 AST 生成）
  → 类型转换（coerceInput，仅 query：string→number/boolean）
  → 调用 ValidatorFn(input)
  → ValidationResult { valid, issues, data }
```

## 循环引用

校验函数是普通 JS 函数，天然支持递归调用。生成时按类型名命名（如 `validate_TreeNode`），遇到自引用直接调用同名函数，无需特殊处理。

## 类型转换规则

仅对 query 参数生效（URL 参数都是 string）：

| 目标类型 | 转换规则 |
| --- | --- |
| `number` | `Number()` 转换，NaN 则失败 |
| `boolean` | `'true'/'1'` → true，`'false'/'0'` → false，其他失败 |
| `string` | 不转换 |

## 相关模块

- [ast](../ast/README.md)：AST 分析，提取类型信息 + 生成校验函数代码
- [cli/generateSchema.ts](../cli/generateSchema.ts)：schema 模块生成
- [errors](../errors/README.md)：ValidationError / InternalError
