/**
 * JSON-RPC 2.0 协议消息类型、解析和响应构建
 *
 * MCP 协议基于 JSON-RPC 2.0，所有通信都是 JSON-RPC 消息。
 * 本模块提供类型定义、消息判定函数和响应构建工具。
 */

// ─── 消息类型 ───────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcResultResponse {
  jsonrpc: '2.0';
  id: string | number;
  result: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  error: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcResultResponse
  | JsonRpcErrorResponse;

// ─── 错误码 ─────────────────────────────────────────────

export const ErrorCode = {
  // JSON-RPC 标准错误码
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  // MCP 扩展错误码
  ConnectionClosed: -32000,
  RequestTimeout: -32001,
} as const;

// ─── 消息判定 ───────────────────────────────────────────

export function isRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return 'method' in msg && 'id' in msg && !('result' in msg) && !('error' in msg);
}

export function isNotification(msg: JsonRpcMessage): msg is JsonRpcNotification {
  return 'method' in msg && !('id' in msg);
}

export function isResultResponse(msg: JsonRpcMessage): msg is JsonRpcResultResponse {
  return 'result' in msg && 'id' in msg;
}

export function isErrorResponse(msg: JsonRpcMessage): msg is JsonRpcErrorResponse {
  return 'error' in msg && 'id' in msg;
}

// ─── 响应构建 ───────────────────────────────────────────

export function createResultResponse(id: string | number, result: unknown): JsonRpcResultResponse {
  return { jsonrpc: '2.0', id, result };
}

export function createErrorResponse(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcErrorResponse {
  const error: JsonRpcError = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

// ─── 消息解析 ───────────────────────────────────────────

/**
 * 解析 JSON-RPC 消息（单条或批量）
 *
 * @throws ParseError（返回 Error 对象，不抛异常）
 * @returns 消息数组（单条也包装为数组）
 */
export function parseJsonRpcMessage(data: unknown): JsonRpcMessage[] {
  if (Array.isArray(data)) {
    if (data.length === 0) {
      throw new JsonRpcParseError('Invalid Request: empty batch');
    }
    return data.map((item) => parseSingleMessage(item));
  }
  return [parseSingleMessage(data)];
}

class JsonRpcParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JsonRpcParseError';
  }
}

export { JsonRpcParseError };

function parseSingleMessage(data: unknown): JsonRpcMessage {
  if (typeof data !== 'object' || data === null) {
    throw new JsonRpcParseError('Invalid Request: not an object');
  }
  const obj = data as Record<string, unknown>;
  if (obj.jsonrpc !== '2.0') {
    throw new JsonRpcParseError('Invalid Request: jsonrpc must be "2.0"');
  }
  // Request: has method + id
  if (
    typeof obj.method === 'string' &&
    (typeof obj.id === 'string' || typeof obj.id === 'number')
  ) {
    return {
      jsonrpc: '2.0',
      id: obj.id,
      method: obj.method,
      ...(obj.params !== undefined && { params: obj.params }),
    } as JsonRpcRequest;
  }
  // Notification: has method, no id
  if (typeof obj.method === 'string' && obj.id === undefined) {
    return {
      jsonrpc: '2.0',
      method: obj.method,
      ...(obj.params !== undefined && { params: obj.params }),
    } as JsonRpcNotification;
  }
  // Response: has result or error + id
  if ('result' in obj && (typeof obj.id === 'string' || typeof obj.id === 'number')) {
    return {
      jsonrpc: '2.0',
      id: obj.id,
      result: obj.result,
    } as JsonRpcResultResponse;
  }
  if ('error' in obj && obj.error !== null && typeof obj.error === 'object') {
    return {
      jsonrpc: '2.0',
      id: (obj.id as string | number | null) ?? null,
      error: obj.error as JsonRpcError,
    } as JsonRpcErrorResponse;
  }
  throw new JsonRpcParseError('Invalid Request: unknown message shape');
}
