---
'@faapi/faapi': major
---

feat!: 统一 JSON 序列化契约——JSON 原生类型之外的一切值转换为可逆的原生表示

设计契约：**线上格式即契约**。JSON 规范只支持 string/number/boolean/null/object/array，框架序列化出口（`toResponse`、`ctx.ok`/`ctx.fail`/`ctx.json`、错误兜底、SSE/WS 消息帧、`app.inject()` 的 body）把规范外类型统一转换为可逆的原生表示，客户端按转换后类型消费或自行还原，不提供序列化之外的第二条数据通路。

**BREAKING CHANGE**——转换规则：

| 值 | 旧输出 | 新输出 | 客户端还原 |
|----|--------|--------|-----------|
| `Date` | ISO 8601 字符串 | **毫秒时间戳（number）** | `new Date(ts)` |
| `BigInt` | 抛 TypeError → 500 | 字符串 | `BigInt(s)` |
| `Map` | `"{}"`（静默丢数据） | entries 数组 | `new Map(entries)` |
| `Set` | `"{}"`（静默丢数据） | 值数组 | `new Set(arr)` |
| `NaN` / `±Infinity` | `null`（静默丢信息） | `"NaN"` / `"±Infinity"` 字符串 | `Number(s)` |
| `RegExp` | `"{}"`（静默丢数据） | `"/source/flags"` 字符串 | `new RegExp(source, flags)` |

循环引用仍抛 `TypeError` 显式失败。带 `toJSON` 的类型（`URL` 等）保持原生行为；`Error` 不做特殊转换（自动展开 stack 有泄漏风险）。

**配套输入侧**：`Date` 字段 schema 同时接受 ISO 字符串与毫秒时间戳（`new Date(v)` 双形态还原），GET 拿到的时间戳可直接 POST 回传，序列化可逆。

**BREAKING CHANGE**——移除 `app.inject()` 的 `raw` 字段（6.11.0 引入）：inject 的 body 与真实 HTTP 客户端拿到的完全相同（同一序列化契约），不存在第二种同进程形态。RSC 同进程取数按 wire 类型消费（`updatedAt` 为 number 时间戳）或在消费点 `new Date(ts)` 还原。
