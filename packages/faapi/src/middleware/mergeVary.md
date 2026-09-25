# mergeVary

一句话概括：向延迟落头的响应 meta.headers 大小写不敏感地合并 Vary 值，供需要声明响应缓存维度的中间件共用。

## 为什么需要

CORS（`Vary: Origin`）与 compression（`Vary: Accept-Encoding`）都要声明"响应内容随某请求头变化"。此前 CORS 读的是**请求头**（`ctx.headers.get('vary')`）——既看不到其他中间件已设置的响应 Vary（会被覆盖），还会把客户端伪造的 Vary 请求头带进响应（缓存污染面）。收敛为单一实现后：读权威来源 meta.headers、大小写不敏感去重、多值逗号合并。

## 使用场景

- `cors.ts`——origin 为动态值（true / 数组）时合并 `Origin`
- `compression.ts`——无条件协商合并 `Accept-Encoding`
- 其他需要声明 Vary 维度的中间件（如自定义语言协商）

## 相关模块

- `cors.ts` / `compression.ts` — 消费方
- `../response/pendingMeta.ts` — meta.headers 的延迟落头通道（本函数写入的来源）
