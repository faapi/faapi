/**
 * Streamable HTTP transport：Web Request → JSON-RPC → Response
 *
 * MCP Streamable HTTP transport 规范：
 * - POST：发送 JSON-RPC 消息，返回 JSON 响应或 SSE 流
 * - GET：打开 SSE 流接收服务端推送
 * - DELETE：终止会话
 *
 * 会话管理通过 Mcp-Session-Id header。
 * 实现：POST 返回 JSON,GET 返回 SSE 流(仅心跳,不推送业务消息),DELETE 销毁会话。
 */

import type { McpServer } from './mcpServer';
import {
  type JsonRpcMessage,
  isRequest,
  isNotification,
  createErrorResponse,
  ErrorCode,
  parseJsonRpcMessage,
  JsonRpcParseError,
} from './jsonRpc';

/** 默认 SSE 心跳间隔 */
const DEFAULT_SSE_HEARTBEAT_MS = 30_000;

/**
 * 处理 MCP HTTP 请求
 *
 * 接收 Web API Request，返回 Web API Response。
 * 可直接在 faapi handler 中使用：
 * ```ts
 * export function POST(ctx) {
 *   return mcp.handleWebRequest(ctx.request);
 * }
 * ```
 */
export async function handleMcpRequest(request: Request, server: McpServer): Promise<Response> {
  switch (request.method) {
    case 'POST':
      return handlePost(request, server);
    case 'GET':
      return handleGet(server, request);
    case 'DELETE':
      return handleDelete(request, server);
    default:
      return new Response(null, { status: 405 });
  }
}

/**
 * 处理 GET 请求:打开 SSE 流,定期推送心跳维持连接
 *
 * 若携带 Mcp-Session-Id 头,会在 stream start 时注册 SSE 订阅者,
 * 服务端 sendLogging 等推送方法可通过 broadcastToSession 推送到客户端。
 *
 * 客户端断开时 stream cancel 触发,清理定时器 + 注销订阅者避免泄漏。
 */
function handleGet(server: McpServer, request: Request): Response {
  const heartbeatMs = server.getSseHeartbeatMs() ?? DEFAULT_SSE_HEARTBEAT_MS;
  const encoder = new TextEncoder();
  let interval: ReturnType<typeof setInterval> | undefined;
  let subscriber:
    | { controller: ReadableStreamDefaultController<Uint8Array>; sessionId: string }
    | undefined;

  const sessionId = request.headers.get('mcp-session-id') ?? undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // 初始连接确认
      controller.enqueue(encoder.encode(': connected\n\n'));

      // 若有 session id,注册订阅者(用于服务端推送)
      if (sessionId) {
        subscriber = server.getSessionManager().addSubscriber(sessionId, controller);
      }

      // 心跳定时器
      interval = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: keepalive ${Date.now()}\n\n`));
        } catch {
          // controller 已关闭,清理定时器
          if (interval) clearInterval(interval);
        }
      }, heartbeatMs);
    },
    cancel() {
      // 客户端断开,清理定时器 + 注销订阅者避免泄漏
      if (interval) clearInterval(interval);
      if (subscriber) {
        server.getSessionManager().removeSubscriber(subscriber);
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

async function handlePost(request: Request, server: McpServer): Promise<Response> {
  // 解析请求体
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(
      400,
      createErrorResponse(null, ErrorCode.ParseError, 'Parse error: Invalid JSON'),
    );
  }

  // 解析 JSON-RPC 消息
  let messages: JsonRpcMessage[];
  try {
    messages = parseJsonRpcMessage(body);
  } catch (err) {
    const message = err instanceof JsonRpcParseError ? err.message : 'Invalid JSON-RPC message';
    return jsonResponse(400, createErrorResponse(null, ErrorCode.ParseError, message));
  }

  // 分离请求和通知
  const requests = messages.filter(isRequest);
  const notifications = messages.filter(isNotification);

  // initialize 请求豁免 Accept 头校验(首次握手)
  const hasInitialize = requests.some((r) => r.method === 'initialize');
  if (!hasInitialize) {
    // MCP 2025-06-18 规范:Accept 头必须同时包含 application/json 和 text/event-stream
    const acceptHeader = request.headers.get('accept') ?? '';
    const accepts = acceptHeader
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0);
    const hasJson = accepts.some(
      (s) => s === 'application/json' || s.startsWith('application/json;'),
    );
    const hasSse = accepts.some(
      (s) => s === 'text/event-stream' || s.startsWith('text/event-stream;'),
    );
    if (!hasJson || !hasSse) {
      return jsonResponse(
        400,
        createErrorResponse(
          null,
          ErrorCode.InvalidRequest,
          'Accept header must include both application/json and text/event-stream',
        ),
      );
    }
  }

  // 查找 session（非 initialize 请求需要 session）
  const sessionId = request.headers.get('mcp-session-id') ?? undefined;
  const sessionManager = server.getSessionManager();
  let session = sessionId ? sessionManager.get(sessionId) : undefined;

  if (hasInitialize) {
    if (session) {
      // 已有 session 却再次 initialize
      return jsonResponse(
        400,
        createErrorResponse(null, ErrorCode.InvalidRequest, 'Server already initialized'),
      );
    }
    // 先创建 session，handleJsonRpc 中会填充 protocolVersion 等信息
    session = sessionManager.create();
  } else if (requests.length > 0 && !session && sessionId) {
    // 有 session ID 但找不到
    return jsonResponse(
      404,
      createErrorResponse(null, ErrorCode.RequestTimeout, 'Session not found'),
    );
  }

  // 处理通知（无响应）
  for (const notification of notifications) {
    await server.handleJsonRpc(notification, session);
  }

  // 处理请求
  const responses: JsonRpcMessage[] = [];
  for (const req of requests) {
    const response = await server.handleJsonRpc(req, session);
    if (response !== null) {
      responses.push(response);
    }
  }

  // 构建响应
  if (requests.length === 0) {
    // 全是通知 → 202 Accepted
    return new Response(null, { status: 202 });
  }

  const responseHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  // initialize 响应需带 Mcp-Session-Id header
  if (hasInitialize && session) {
    responseHeaders['Mcp-Session-Id'] = session.id;
  }

  const responseBody = responses.length === 1 ? responses[0] : responses;
  return new Response(JSON.stringify(responseBody), {
    status: 200,
    headers: responseHeaders,
  });
}

function handleDelete(request: Request, server: McpServer): Promise<Response> {
  const sessionId = request.headers.get('mcp-session-id');
  if (!sessionId) {
    return Promise.resolve(
      jsonResponse(
        400,
        createErrorResponse(null, ErrorCode.InvalidRequest, 'Missing Mcp-Session-Id header'),
      ),
    );
  }

  const deleted = server.getSessionManager().delete(sessionId);
  if (!deleted) {
    return Promise.resolve(
      jsonResponse(404, createErrorResponse(null, ErrorCode.RequestTimeout, 'Session not found')),
    );
  }

  return Promise.resolve(new Response(null, { status: 200 }));
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
