---
'@faapi/next': patch
---

`apiCall` 对合法 JSON 但非对象形态的响应体（如 `JSON.parse("null") === null`、裸数字）补守卫，归入 `NON_JSON_RESPONSE` 结构化错误——此前 `body.error` 访问抛裸 `TypeError`（Cannot read properties of null），击穿"失败一律转译为 ApiError"的模块承诺。
