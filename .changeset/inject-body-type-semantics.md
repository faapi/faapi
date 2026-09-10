---
'@faapi/faapi': minor
---

`app.inject` 的 `body` 语义按类型区分（与 fastify inject 约定一致）：`string` / `Uint8Array`（含 `Buffer`）原样透传不再被 `JSON.stringify` 二次编码（默认 content-type 分别为 `text/plain` / `application/octet-stream`），其他值（对象/数组等）保持 `JSON.stringify` + `application/json` 不变。此前 string body 会被静默二次编码成 JSON 字符串字面量，schema 校验报 `TYPE_MISMATCH`，报错点离出错点远。同时调用方显式传入的 `content-type` 头改为**优先于默认值**（原先被强制覆写为 `application/json`）——string body + `application/x-www-form-urlencoded` 可直接测 form 表单路由。传预编码 JSON 字符串当对象用的存量调用需改为传原始对象。
