# queryToObject

一句话概括：将 URLSearchParams 转换为普通对象，重复 key 聚合为数组。

## 为什么需要

URLSearchParams 是迭代器，不便于类型校验和属性访问。转换为普通对象后，可以进行参数校验。

重复 key 语义：`?tag=a&tag=b` 聚合为 `{ tag: ['a', 'b'] }`（对齐 Express qs /
Hono `getAll`）。此前 last-wins 静默丢弃前面的值，且 query schema 的 coerce
管线对 array 元素同样生成 preprocess——声明 `ids: number[]` 的字段此前永远
校验失败（解析端从未产出数组），属于校验管线输入端漏洞。单值字段（绝大多数
场景）保持字符串不变，无行为影响。

## 使用场景

- GET 请求参数提取
- 转换查询参数为可校验对象

## 相关模块

- `resolveInput.ts` - 提取 GET/DELETE 参数
