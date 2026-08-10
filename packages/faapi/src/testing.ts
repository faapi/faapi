/**
 * 测试辅助导出入口（子路径 `@faapi/faapi/testing`）
 *
 * 业务方测试 handler / 中间件 / 注入器 / E2E 完整链路 / WebSocket 路由时，从此入口导入：
 *
 * ```ts
 * import { createTestContext, invokeHandler } from '@faapi/faapi/testing';
 * ```
 *
 * 与主入口 `@faapi/faapi` 的关系：测试 API 单独拆到子路径，
 * 使业务方生产代码与测试代码导入分离，且便于 tree-shaking。
 *
 * 详见 `src/testing.md`。
 */

// 轻量测试（不需启动服务器）
export { createTestContext, type CreateTestContextOptions } from './runtime/createContext';
export { invokeHandler } from './runtime/invokeHandler';
export type { FaapiContext } from './runtime/contextTypes';
export type { FaapiMiddleware } from './middleware/middlewareTypes';
export type { InjectorMap } from './middleware/injectorTypes';

// E2E 测试辅助（业务方测试完整请求链路 + WS 路由）
export { createTestServer, type TestServer, type TestServerOptions } from './testServer';
export {
  connectWs,
  MessageQueue,
  waitForWsOpen,
  type WsTestClient,
  type WsTestClientOptions,
} from './wsTestClient';
