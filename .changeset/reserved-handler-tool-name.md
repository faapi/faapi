---
"@faapi/faapi": minor
---

scanTools 新增预留函数名 `handler`：识别为 tool 但函数名不拼进 tool 名，tool 名即命名空间（`src/tools/weather/handler.ts` 导出 `handler` → tool 名 `weather`）。目录表达「一个能力一个 tool」的语义单元，与 `handler.ts` 文件名及路由侧约定对称。无命名空间（`src/tools/handler.ts`）时扫描期抛错；`handler` 与同文件普通函数可共存，合成名冲突走全局重名检测。
