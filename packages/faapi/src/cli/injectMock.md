# injectMock

一句话概括：`app.inject()` 的无服务器注入实现——mock IncomingMessage/ServerResponse 喂给真实的 request listener，走完整请求链路。

## 为什么需要

Next.js Server Component、编程式测试等场景需要「不绑端口走完整链路」。真实链路（CORS/helmet/logger/中间件/schema/handler）零改动——mock 只替换传输层，响应契约（序列化规则、headers 语义）与真实 HTTP 完全一致。

## 使用场景

- `AppBase.inject()`（createAppCore 门面转发到 `performInject`）
- `listen()` 前后均可调用

## 行为约定

- handler 取 `server.listeners('request')` 的**最后一个**——applyPluginWrappers 包装后 server 上只有一个 request listener；业务方在 config 外自行 addListener 多个 request listener 属未定义行为
- mockRes 为 PassThrough（支持 sendNodeResponse 的 pipe 路径）+ 手工实现 setHeader/appendHeader/writeHead；响应在 'finish' 时收集 chunks 并 JSON.parse（非 JSON 回退字符串）
- body 语义与 fastify inject 一致：string/Uint8Array 原样透传，其他值 JSON.stringify；调用方显式 content-type 优先

## 相关模块

- `createAppCore.ts` — 门面与 AppBase.inject 签名
- `../../response/sendNodeResponse.ts` — mockRes 的消费方（pipe 目标）
- `../../server/startServer.ts` — applyPluginWrappers（listener 包装语义）
