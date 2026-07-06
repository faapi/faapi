# routeSchema

一句话概括：从路由清单生成接口 schema 描述（含输入与响应类型），供 MCP server 暴露给 LLM。

## 为什么需要

MCP server 需要结构化的路由信息供 LLM 查询。本模块直接调用主包 `collectRouteSchemaSources` 执行 AST 分析，提取每个路由 handler 的输入参数类型与返回类型，把路由清单转换为包含参数/响应类型详情的 RouteInfo[]，不依赖运行时 schemaRegistry。

## 使用场景

`createSchemaServer` 初始化时调用，构建路由 schema 缓存供 MCP resource 查询。

## 架构

```
RouteManifest
  → collectRouteSchemaSources（AST 从源码 .ts 提取每个 handler 的类型）
  → buildRouteSchemas（遍历路由清单）
    ├─ 输入:extractInputSchemas(query/body + params 兜底)
    └─ 响应:extractOutputSchema(返回类型节点 → Promise 解包 → runtimeType)
  → RouteInfo[]（缓存,含 inputs + output）
  → MCP resource 查询时返回
```

## 输入类型提取

输入侧逻辑保持不变：

- `getInputTypeForMethod(method)` 确定主输入类型:GET/DELETE/HEAD → query,其余 → body
- schemaName = `${METHOD}${InputType}`(如 `GETQuery`、`POSTBody`)
- 从 `collectRouteSchemaSources` 返回的 sourceMap 查询 AST 提取结果
- 无类型声明时 properties 为空
- 动态路由无 params 类型声明时,用 `route.paramNames` 兜底为 `string[]`

## 响应类型提取(新增)

### 提取流程

`extractOutputSchema(route, program, filePath)`:

1. 用 TypeScript Compiler API 直接定位 handler 函数节点(`GET`/`POST` 等)
2. 读取 `node.type`(显式返回类型注解)
3. 无返回类型注解 → 返回 `null`(无法静态分析,不猜测)
4. 有返回类型注解 → 解包 Promise(若存在)→ 解析为 `RouteOutputSchema`

### Promise 解包策略

handler 通常是 async 函数,返回类型为 `Promise<T>`。提取时必须解包取 T:

| 返回类型注解 | 解包后 | output.schemaName | output.runtimeType |
|---|---|---|---|
| `Promise<UserResponse>` | `UserResponse` | `'UserResponse'` | ref |
| `Promise<{ id: number }>` | `{ id: number }` | `null` | object |
| `Promise<string>` | `string` | `null` | string |
| `Promise<void>` | `void` | `null` | null(返回 null output) |
| `UserResponse`(非 async) | `UserResponse` | `'UserResponse'` | ref |
| `{ id: number }`(非 async) | `{ id: number }` | `null` | object |
| 无返回类型注解 | — | — | 返回 null output |

解包规则:
- 仅解包一层 `Promise<T>`(不递归解包 `Promise<Promise<T>>`,实际场景不会出现)
- `Promise<void>` 等价于 `void` → output 为 null
- 非 Promise 类型直接解析

### 与运行时校验路径的差异

主包 `resolveTypeNode` 在遇到 `Promise` 时**直接抛错**(运行时校验场景下 Promise 无法校验)。本模块**不抛错而是解包**,因为响应类型提取是给 LLM 看的静态描述,不需要运行时校验。

为避免修改主包行为,Promise 解包逻辑**在 schema 包内独立实现**,不修改主包 `resolveTypeNode`。

### 解包后的类型解析

解包后的类型节点复用主包能力:

- 命名类型引用(`UserResponse`)→ 调 `extractTypeInfo(program, filePath, typeName)` 提取完整结构
- 内联对象/基础类型/联合/数组等 → 调 `resolveTypeNode(typeNode, checker)` 解析
- 解析失败抛 `SchemaExtractionError` → 在 `buildRouteSchemas` 中 catch,降级为 `output: null`(不阻断整个路由 schema 构建)

### RouteOutputSchema 结构

```ts
interface RouteOutputSchema {
  /** 命名类型名(如 'UserResponse'),内联类型为 null */
  schemaName: string | null;
  /** 顶层属性列表(schemaName 为命名类型时从 typeInfo.properties 提取) */
  properties: RouteParamSchema[];
  /** 完整运行时类型描述(用于 MCP 暴露结构化嵌套类型) */
  runtimeType: RuntimeType;
}
```

`RouteInfo.output` 为 `RouteOutputSchema | null`:
- `null`:无返回类型注解,或 `void`/`Promise<void>`,或解析失败降级
- 对象:有可解析的返回类型

## 已知限制

- **不分析全局中间件包装**:若业务方在全局中间件中修改 handler 返回值(如包装为 `{ code: 0, data, message }`),output 反映的是 handler 原始返回类型,不是客户端实际收到的包装后结构。AI 助手需结合业务中间件理解实际响应。框架不内置统一响应包装配置,推荐业务方使用 `ok()` 辅助函数保持类型一致。
- **不解析推断类型**:handler 无显式返回类型注解时(`export function GET(query) { return query }`),output 为 null。TypeScript 编译器能推断,但 AST 静态分析不深入做数据流推断。
- **Promise 解包仅一层**:`Promise<Promise<T>>` 不会递归解包(实际代码不会出现)。

## 相关模块

- [@faapi/faapi](../../faapi/) - 提供公开能力:`collectRouteSchemaSources`(AST 提取路由 schema 源数据)、`extractTypeInfo`、`getInputTypeForMethod`、`RuntimeType` / `PropertyType` 类型、`resolveTypeNode`
- [schemaServer.ts](./schemaServer.md) - 消费 RouteInfo[],通过 MCP resource 暴露给 LLM
