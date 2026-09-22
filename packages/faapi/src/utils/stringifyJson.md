# stringifyJson

一句话概括：框架统一 JSON 序列化出口——JSON 原生类型之外的一切值转换为**可逆的原生表示**（Date → 毫秒时间戳、BigInt → 字符串、Map/Set → 数组等），其余行为与原生 `JSON.stringify` 一致。

## 为什么需要

JSON 规范只支持 string/number/boolean/null/object/array。原生 `JSON.stringify` 对规范外类型的行为不可接受：

| 值 | 原生行为 | 问题 |
|----|---------|------|
| `BigInt` | 抛 `TypeError` | 含 BigInt 的响应直接 500 |
| `Date` | ISO 字符串（`toJSON`） | 可用但与「时间戳」契约不一致（见下） |
| `Map` / `Set` | `"{}"` | **静默丢数据** |
| `NaN` / `±Infinity` | `null` | **静默丢信息**（与合法 null 歧义） |
| `RegExp` | `"{}"` | **静默丢数据** |

框架的设计契约：**线上格式即契约**——序列化把规范外类型转换为可逆的原生表示，客户端按转换后类型消费或自行还原（`new Date(ts)` / `BigInt(s)` / `new Map(entries)`…）。不提供序列化之外的第二条数据通路（如 bypass 序列化的原始值通道）：同进程与跨进程消费看到的 body 形态唯一，类型标注以 wire 类型为准。

Date 选择毫秒时间戳而非 ISO 字符串：JS 生态惯例（`Date.now()` / Java `System.currentTimeMillis()` 同单位），数值比较/排序直接可用，客户端 `new Date(ts)` 一步还原；配合输入侧 schema 同时接受 ISO 字符串与时间戳（`ast/generateZodSchema.ts` 的 Date preprocess），GET → POST 回传可逆。

## 使用场景

- 框架内所有 JSON 序列化出口统一使用：`toResponse`（对象/数组/fallback 分支）、`jsonRaw`（`ctx.ok`/`ctx.fail`/`ctx.json`/错误兜底 `formatErrorResponse`）、SSE `send` 的对象 data、WS `send` 的对象数据、`app.inject()` 的 body
- 业务侧自定义 `response.ok` / `response.fail` 包装函数返回值仍经 `jsonRaw` 序列化，自动获得同样行为

## 相关模块

- `../response/toResponse.ts` - 成功路径序列化
- `../response/responseFormatter.ts` - 显式响应与错误兜底序列化
- `../runtime/sse.ts` / `../runtime/wsHandler.ts` - 消息帧序列化
- `../ast/generateZodSchema.ts` - 输入侧 Date preprocess（接受 ISO 字符串 + 毫秒时间戳，与输出可逆）

## 转换规则

| 值 | JSON 输出 | 客户端还原 |
|----|-----------|-----------|
| `Date`（含子类） | 毫秒时间戳（`getTime()`） | `new Date(ts)` |
| `BigInt`（含嵌套/toJSON 返回值） | 字符串（`toString()`） | `BigInt(s)` |
| `Map` | entries 数组（键值各自递归转换） | `new Map(entries)` |
| `Set` | 值数组（元素递归转换） | `new Set(arr)` |
| `NaN` / `Infinity` / `-Infinity` | `"NaN"` / `"Infinity"` / `"-Infinity"` 字符串 | `Number(s)` |
| `RegExp` | `"/source/flags"` 字符串 | `new RegExp(source, flags)` |
| 循环引用 | 抛 `TypeError`（结构错误显式失败，不静默产出坏 JSON） | — |

不转换的（保持原生 `JSON.stringify` 语义）：

- 带 `toJSON` 的类型（`URL`、dayjs 等）：由原生序列化自然处理——只有 plain object/array 会被递归遍历找嵌套的特殊类型，其他对象（类实例等）原样交给原生序列化
- 函数 / `symbol`：对象属性中被丢弃（原生规则）
- `undefined`：对象属性丢弃、数组中转 `null`（原生规则）
- `Error`：序列化为 `{}`（原生行为）。框架不做 Error 特殊转换——自动展开 `stack` 有泄漏风险，错误信息应经 `response.fail` / 全局错误中间件显式输出
