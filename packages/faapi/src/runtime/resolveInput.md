# resolveInput

一句话概括：根据 HTTP 方法和 Content-Type 解析请求输入。

## 为什么需要

GET/DELETE 从 URL 提取 query，POST/PUT/PATCH 从请求体提取数据，需要统一接口。
不同 Content-Type（JSON / multipart / form-urlencoded）解析方式不同，且空 body
与非法 JSON 需要区分对待（前者视为无 body，后者抛 ValidationError）。

## 使用场景

- 请求处理时解析输入
- 请求热路径用 `resolveInputFromUrl(method, request, url)` 变体——createServer 每请求已持有解析好的 URL（`toWebRequest` 内唯一一次 `new URL`），query 分支复用其 searchParams，避免重复解析。普通场景用 `resolveInput`
- 根据 method 选择输入来源（query 或 body）
- 根据 Content-Type 选择 body 解析方式

## 行为约定

| Content-Type                       | 行为                                       |
| ---------------------------------- | ------------------------------------------ |
| `multipart/form-data`              | 调用 `parseMultipart`，返回 `{ fields, files }` |
| `application/x-www-form-urlencoded`| 按 `URLSearchParams` 解析为字符串字段对象    |
| 其它（默认 JSON）                   | 调用 `parseJsonBody` 解析                    |

- 两个解析函数均返回 `{ input, rawBody }`：`input` 进校验管线；`rawBody` 为
  请求体原始文本（JSON 为未解析字符串、form-urlencoded 为原始编码文本；
  multipart 与无请求体为 undefined），由 createServer 挂载到 `ctx.rawBody`
- 空请求体（含纯空白）：`input` 返回 `null`（有 schema 时 safeParse 失败 422，
  无 schema 透传；POST 与 DELETE 的 body 空体行为完全一致）
- 非空请求体且 JSON 解析失败：抛 `ValidationError(code=INVALID_FORMAT)`，
  不再静默返回 `null` 导致后续报"字段缺失"

### DELETE body（resolveBodyForQueryMethod）

DELETE 主输入（校验用）是 query，但请求体流必须被消费（keep-alive 连接上有未读
body 时 Node 只能断开连接），且 handler 声明 `body` 参数时应注入真正的请求体。
`createServer` 调 `resolveBodyForQueryMethod(request)` 单独解析，Content-Type
分流与 POST/PUT/PATCH 主输入完全对称（JSON / form-urlencoded / multipart）；
空请求体 `input` 为 `null`，与 POST 同路径。解析结果的 schema 校验由
`createServer` 管线执行——handler 声明 `body`/`form` 形参时存在 `DELETEBody`
schema，校验通过后注入（Date 字段转换与 POST body 一致；form 声明 coerce=true）；
未声明则无 schema，原样注入（详见
[createServer](../server/createServer.md) 的「输入校验覆盖」）。

## 相关模块

- `queryToObject.ts` - 提取 query
- `parseJsonBody.ts` - 解析 JSON（保持纯函数,不抛错）
- `parseMultipart.ts` - 解析 multipart
- `../errors/httpErrors.ts` - `ValidationError` 定义
