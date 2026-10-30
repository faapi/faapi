---
"@faapi/task-pgboss": patch
---

修复 `groups.create` 在 jsonb 列绑参与幂等比对上的两处缺陷：

- `payloads` / `carry` 先 `JSON.stringify` 成 JSON 文本再绑参（缺省保持 SQL NULL）——此前 JS 数组裸绑，node-pg 对顶层数组输出 PG 数组字面量而非 JSON，`enqueueSequence` 入队必抛 22P02（`invalid input syntax for type json`）
- 同 id 重投的幂等比对改为结构深比对（对象键序无关）——此前 `JSON.stringify` 逐字比，PG jsonb 读回重排键序会把同参重投误判为 "already exists with different options"
