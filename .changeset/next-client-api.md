---
'@faapi/next': minor
---

新增 `@faapi/next/client` 浏览器端请求层：`apiCall` 封装 fetch + faapi 信封解包，失败统一抛结构化 `ApiError`（code/status/message/issues）。外部 HTML 响应（反代/网关错误页、Next.js 404 页、SSO 登录页重定向）不再以裸 `Unexpected token '<'` SyntaxError 直上界面，而是转译为可行动的中文提示，排障现场（状态码/URL/body 片段）保留在 console.error。客户端组件必须从 `@faapi/next/client` 子路径导入（零 Node 依赖，可安全进入浏览器 bundle）。
