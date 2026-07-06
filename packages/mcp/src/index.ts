/**
 * @faapi/mcp — MCP Server SDK for faapi
 *
 * 纯手写 MCP 协议实现，不依赖 @modelcontextprotocol/sdk。
 * 仅支持 Streamable HTTP transport，zod-native tool 定义。
 *
 * 核心导出：
 * - createMcpServer：创建 MCP Server 实例
 * - createMcpHandler：创建 faapi handler 函数
 * - handleMcpRequest：处理 Web Request
 *
 * 用法：
 * ```ts
 * // api/mcp/handler.ts
 * import { createMcpServer, createMcpHandler } from '@faapi/mcp';
 * import { z } from 'zod';
 *
 * const mcp = createMcpServer({ name: 'my-app', version: '1.0.0' });
 *
 * mcp.tool('hello', {
 *   description: 'Say hello',
 *   input: { name: z.string() },
 *   handler: async ({ name }) => ({
 *     content: [{ type: 'text', text: `Hello, ${name}!` }],
 *   }),
 * });
 *
 * export const { POST, GET, DELETE } = createMcpHandler(mcp);
 * ```
 */

// Server
export { createMcpServer, McpServer } from './mcpServer';
export type {
  McpServerOptions,
  McpToolDefinition,
  McpToolResult,
  ToolCallExtra,
  SendLoggingFn,
  SendProgressFn,
  RequestExtra,
  MethodHandler,
  MethodHandlerResult,
  McpResourceDefinition,
  McpResourceContent,
  McpResourceReadResult,
  ResourceReadExtra,
  McpResourceTemplateDefinition,
  ResourceTemplateReadExtra,
  McpPromptDefinition,
  McpPromptArgument,
  McpPromptContent,
  McpPromptMessage,
  McpPromptGetResult,
  PromptGetExtra,
  CompletionRef,
  CompletionContext,
  CompletionResult,
  CompletionHandler,
} from './mcpServer';

// Transport
export { handleMcpRequest } from './streamableHttp';

// faapi 适配器
export { createMcpHandler, createMcpNodeHandler } from './faapiAdapter';

// Session
export { SessionManager } from './session';
export type { McpSession, LoggingLevel, SseSubscriber } from './session';

// JSON-RPC
export {
  ErrorCode,
  isRequest,
  isNotification,
  isResultResponse,
  isErrorResponse,
  createResultResponse,
  createErrorResponse,
  parseJsonRpcMessage,
  JsonRpcParseError,
} from './jsonRpc';
export type {
  JsonRpcRequest,
  JsonRpcNotification,
  JsonRpcResultResponse,
  JsonRpcErrorResponse,
  JsonRpcError,
  JsonRpcMessage,
} from './jsonRpc';

// 协议常量
export { PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from './mcpServer';
