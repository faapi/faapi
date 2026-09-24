/**
 * @faapi/next/client —— 浏览器端请求层入口。
 *
 * 客户端组件('use client')统一从本子路径导入:
 * `import { apiCall, ApiError } from '@faapi/next/client'`。
 *
 * 零依赖约束:本入口禁止 import @faapi/faapi 及任何 Node/服务端模块
 * (传递性引入会把服务端代码拉进浏览器 bundle,详见 apiError.md)。
 */
export { ApiError, type ApiEnvelope, type ApiValidationIssue } from './apiError';
export { apiCall, statusMessage } from './apiCall';
