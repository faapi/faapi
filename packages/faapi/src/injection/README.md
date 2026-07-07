# 依赖注入

faapi 的核心设计是"函数即接口"。框架根据 handler 参数名自动识别注入类型，将 query、body、params、headers、context 等自动注入，无需手动从 context 提取。

## 注入类型映射

| 参数名 | 注入类型 | 来源 |
| --- | --- | --- |
| `query` / `Query` | query | URLSearchParams → plain object |
| `body` / `Body` | body | 请求 body（仅 POST/PUT/PATCH，JSON 解析） |
| `form` / `Form` | form | `application/x-www-form-urlencoded` body（与 body 共享解析结果，schema coerce=true） |
| `params` | params | 动态路由参数 |
| `headers` | headers | 请求头 |
| `context` / `ctx` | context | 完整 FaapiContext |
| `cookies` | cookies | 解析后的 cookie 键值对（Record<string, string>） |
| `ip` | ip | 客户端 IP（X-Forwarded-For 优先） |
| `files` | files | multipart 上传文件列表（UploadedFile[]） |
| `fields` | fields | multipart 表单字段（Record<string, string>） |
| 其他 | unknown | 不注入（由中间件 resolve 提供） |

## 模块

| 模块 | 说明 |
| --- | --- |
| [resolveInjection.ts](./resolveInjection.md) | 运行时参数名解析 |
| [analyzeInjection.ts](./analyzeInjection.md) | AST 参数注入分析 |
| [injectParams.ts](./injectParams.md) | 参数注入执行 |

## 边界

- 不支持自定义注入类型扩展。
- 不支持装饰器注入。
- 不支持基于参数位置而非名称的注入。
- 无参数的 handler 直接调用，不做注入。
- body 注入仅对 POST/PUT/PATCH 生效。
- `form` 与 `body` 互斥：handler 声明其一即可。`form` 共享 `body` 的解析结果（`resolveInput` 已按 Content-Type 解析 form-urlencoded 为 `Record<string, string>`），差异仅在 schema 校验（`form` coerce=true，`body` coerce=false）。
