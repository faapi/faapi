/**
 * MCP Server 核心：tool/resource/prompt 注册 + JSON-RPC 方法分发
 *
 * 实现 MCP 协议的核心方法：
 * - initialize：握手，返回 serverInfo + capabilities（根据注册情况动态生成）
 * - notifications/initialized：通知，无响应
 * - tools/list、tools/call：tool 列表与调用
 * - resources/list、resources/read：资源列表与读取
 * - prompts/list、prompts/get：提示列表与获取
 * - ping：心跳
 *
 * Tool 输入参数用 zod schema 声明，通过 zod v4 内置 toJSONSchema 转为 JSON Schema。
 */

import { z, toJSONSchema } from 'zod';
import type { JsonRpcRequest, JsonRpcMessage, JsonRpcErrorResponse } from './jsonRpc';
import { createResultResponse, createErrorResponse, ErrorCode, isNotification } from './jsonRpc';
import { SessionManager, type McpSession, type LoggingLevel } from './session';

// ─── 协议常量 ───────────────────────────────────────────

/** MCP 协议版本（当前实现遵循 2025-06-18 规范） */
export const PROTOCOL_VERSION = '2025-06-18';

/** 支持的协议版本列表 */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26'] as const;

// ─── 类型定义 ───────────────────────────────────────────

export interface McpServerOptions {
  /** Server 名称 */
  name: string;
  /** Server 版本 */
  version: string;
  /** 可选显示名称 */
  title?: string;
  /** 可选给客户端的指引说明 */
  instructions?: string;
  /** 会话空闲超时(毫秒),默认 30 分钟;设为 0 表示永不过期 */
  sessionTtl?: number;
  /** GET SSE 流心跳间隔(毫秒),默认 30 秒 */
  sseHeartbeatMs?: number;
  /** list 方法默认每页项数,默认 100 */
  defaultPageSize?: number;
  /** tools 列表是否可变(声明 listChanged: true + removeTool 时推送通知)。默认 false */
  toolsListChanged?: boolean;
  /** resources 列表是否可变(声明 listChanged: true + removeResource 时推送通知)。默认 false */
  resourcesListChanged?: boolean;
  /** prompts 列表是否可变(声明 listChanged: true + removePrompt 时推送通知)。默认 false */
  promptsListChanged?: boolean;
}

export interface McpToolResult {
  /** 内容数组（text/image/audio/resource_link/resource） */
  content: Array<Record<string, unknown>>;
  /** 是否为 tool 执行错误（区别于协议错误） */
  isError?: boolean;
  /** 结构化输出（配合 outputSchema 使用） */
  structuredContent?: unknown;
}

/** sendLogging 函数类型——推送日志到 session 的 SSE 订阅者 */
export type SendLoggingFn = (level: LoggingLevel, data: unknown, logger?: string) => void;

/** sendProgress 函数类型——推送进度到 session 的 SSE 订阅者 */
export type SendProgressFn = (progress: number, total?: number) => void;

/** 自定义方法的请求 extra(与 tool/resource/prompt handler extra 共享 send* 能力) */
export interface RequestExtra {
  /** 会话 ID */
  sessionId: string;
  /** 推送日志到客户端 SSE 流(无订阅者或被级别过滤时静默丢弃) */
  sendLogging: SendLoggingFn;
  /** 推送进度到客户端 SSE 流(无 progressToken 或无订阅者时静默丢弃) */
  sendProgress: SendProgressFn;
}

/** 自定义方法 handler 返回值——对象作为 result,JsonRpcErrorResponse 作为错误 */
export type MethodHandlerResult = Record<string, unknown> | JsonRpcErrorResponse;

/** 自定义 JSON-RPC 方法 handler 类型 */
export type MethodHandler = (
  params: unknown,
  session: McpSession | undefined,
  extra: RequestExtra,
) => Promise<MethodHandlerResult> | MethodHandlerResult;

export interface ToolCallExtra {
  /** 会话 ID */
  sessionId: string;
  /** 推送日志到客户端 SSE 流(无订阅者或被级别过滤时静默丢弃) */
  sendLogging: SendLoggingFn;
  /** 推送进度到客户端 SSE 流(无 progressToken 或无订阅者时静默丢弃) */
  sendProgress: SendProgressFn;
}

export interface McpToolDefinition {
  /** 工具描述 */
  description?: string;
  /** 输入参数 schema（zod raw shape，如 { name: z.string() }） */
  input?: Record<string, z.ZodType>;
  /** 工具注解（如 readOnlyHint、destructiveHint 等） */
  annotations?: Record<string, unknown>;
  /** 处理函数 */
  handler: (
    args: Record<string, unknown>,
    extra: ToolCallExtra,
  ) => Promise<McpToolResult> | McpToolResult;
}

// ─── resource 类型 ─────────────────────────────────────

export interface McpResourceContent {
  /** 资源 URI */
  uri: string;
  /** MIME 类型 */
  mimeType?: string;
  /** 文本内容(与 blob 二选一) */
  text?: string;
  /** 二进制内容(Base64 编码,与 text 二选一) */
  blob?: string;
}

export interface McpResourceReadResult {
  /** 资源内容数组(支持一个 URI 返回多段内容) */
  contents: McpResourceContent[];
}

export interface ResourceReadExtra {
  /** 会话 ID */
  sessionId: string;
  /** 推送日志到客户端 SSE 流(无订阅者或被级别过滤时静默丢弃) */
  sendLogging: SendLoggingFn;
  /** 推送进度到客户端 SSE 流(无 progressToken 或无订阅者时静默丢弃) */
  sendProgress: SendProgressFn;
}

export interface McpResourceDefinition {
  /** 资源名称(必填) */
  name: string;
  /** 资源描述 */
  description?: string;
  /** MIME 类型 */
  mimeType?: string;
  /** 读取 handler(必填) */
  read: (
    uri: string,
    extra: ResourceReadExtra,
  ) => Promise<McpResourceReadResult> | McpResourceReadResult;
}

interface RegisteredResource {
  uri: string;
  definition: McpResourceDefinition;
}

// ─── resource template 类型 ─────────────────────────

export interface ResourceTemplateReadExtra {
  /** 会话 ID */
  sessionId: string;
  /** 推送日志到客户端 SSE 流(无订阅者或被级别过滤时静默丢弃) */
  sendLogging: SendLoggingFn;
  /** 推送进度到客户端 SSE 流(无 progressToken 或无订阅者时静默丢弃) */
  sendProgress: SendProgressFn;
}

export interface McpResourceTemplateDefinition {
  /** 资源名称(必填) */
  name: string;
  /** 资源描述 */
  description?: string;
  /** MIME 类型 */
  mimeType?: string;
  /** 读取 handler(必填):接收实际 URI 和从 URI 模板提取的 params */
  read: (
    uri: string,
    params: Record<string, string>,
    extra: ResourceTemplateReadExtra,
  ) => Promise<McpResourceReadResult> | McpResourceReadResult;
}

interface RegisteredResourceTemplate {
  uriTemplate: string;
  /** 编译后的正则表达式(用于匹配 URI) */
  regex: RegExp;
  /** 模板中的变量名列表(按出现顺序) */
  paramNames: string[];
  definition: McpResourceTemplateDefinition;
}

// ─── prompt 类型 ───────────────────────────────────────

export interface McpPromptArgument {
  /** 参数名称 */
  name: string;
  /** 参数描述 */
  description?: string;
  /** 是否必填 */
  required?: boolean;
}

export interface McpPromptContent {
  /** 内容类型:text 或 image */
  type: 'text' | 'image';
  /** 文本内容(type=text 时) */
  text?: string;
  /** Base64 编码的图片数据(type=image 时) */
  data?: string;
  /** 图片 MIME 类型(type=image 时) */
  mimeType?: string;
}

export interface McpPromptMessage {
  /** 角色 */
  role: 'user' | 'assistant';
  /** 内容 */
  content: McpPromptContent;
}

export interface McpPromptGetResult {
  /** 提示消息列表 */
  messages: McpPromptMessage[];
}

export interface PromptGetExtra {
  /** 会话 ID */
  sessionId: string;
  /** 推送日志到客户端 SSE 流(无订阅者或被级别过滤时静默丢弃) */
  sendLogging: SendLoggingFn;
  /** 推送进度到客户端 SSE 流(无 progressToken 或无订阅者时静默丢弃) */
  sendProgress: SendProgressFn;
}

export interface McpPromptDefinition {
  /** 提示描述 */
  description?: string;
  /** 参数定义 */
  arguments?: McpPromptArgument[];
  /** 获取 handler(必填) */
  get: (
    args: Record<string, string>,
    extra: PromptGetExtra,
  ) => Promise<McpPromptGetResult> | McpPromptGetResult;
}

interface RegisteredPrompt {
  name: string;
  definition: McpPromptDefinition;
}

interface RegisteredTool {
  name: string;
  definition: McpToolDefinition;
  /** 包装后的 z.object schema（用于 safeParse） */
  inputSchema: z.ZodObject<Record<string, z.ZodType>> | undefined;
  /** JSON Schema 表示（用于 tools/list 响应） */
  jsonSchema: Record<string, unknown> | undefined;
}

// ─── completion 类型 ──────────────────────────────────

/** completion 引用——指向某个 prompt 或 resource template */
export type CompletionRef =
  | { type: 'ref/prompt'; name: string }
  | { type: 'ref/resource'; uri: string };

/** completion 调用上下文——传递给 handler */
export interface CompletionContext {
  /** 客户端已填写的其他参数(部分填充,key 为参数名,value 为已填值) */
  arguments: Record<string, string>;
}

/** completion 返回结果 */
export interface CompletionResult {
  /** 候选值数组 */
  values: string[];
  /** 总数(可选,用于客户端提示"还有 N 项") */
  total?: number;
  /** 是否还有更多(可选,提示客户端可分页或继续输入) */
  hasMore?: boolean;
}

/** completion handler 函数类型 */
export type CompletionHandler = (
  value: string,
  context: CompletionContext,
) => Promise<CompletionResult> | CompletionResult;

interface RegisteredCompletion {
  /** 引用类型 'ref/prompt' | 'ref/resource' */
  refType: 'ref/prompt' | 'ref/resource';
  /** 引用标识(prompt name 或 resource template uri) */
  refId: string;
  /** 参数名 */
  argumentName: string;
  /** 补全 handler */
  handler: CompletionHandler;
}

interface RegisteredMethod {
  name: string;
  handler: MethodHandler;
}

/** MCP 内置方法——禁止业务方注册同名方法,避免覆盖协议行为 */
const BUILTIN_METHODS = new Set<string>([
  'initialize',
  'ping',
  'notifications/initialized',
  'notifications/cancelled',
  'tools/list',
  'tools/call',
  'resources/list',
  'resources/read',
  'resources/templates/list',
  'resources/subscribe',
  'resources/unsubscribe',
  'prompts/list',
  'prompts/get',
  'logging/setLevel',
  'completion/complete',
]);

// ─── 分页工具 ───────────────────────────────────────────

/** 默认每页项数 */
const DEFAULT_PAGE_SIZE = 100;

/** 将偏移量编码为不透明 cursor 字符串 */
function encodeCursor(offset: number): string {
  return Buffer.from(String(offset)).toString('base64');
}

/** 解码 cursor,返回偏移量;无效时抛错 */
function decodeCursor(cursor: string): number {
  const decoded = Buffer.from(cursor, 'base64').toString('utf-8');
  const offset = Number.parseInt(decoded, 10);
  if (!Number.isFinite(offset) || offset < 0 || decoded !== String(offset)) {
    throw new Error(`Invalid cursor: ${cursor}`);
  }
  return offset;
}

/** 对数组切片分页,返回当前页数据和可选的 nextCursor */
function paginate<T>(
  items: T[],
  cursor: string | undefined,
  pageSize: number,
): { items: T[]; nextCursor?: string } {
  const offset = cursor ? decodeCursor(cursor) : 0;
  if (offset > items.length) {
    throw new Error(`cursor out of range: offset ${offset} > total ${items.length}`);
  }
  const slice = items.slice(offset, offset + pageSize);
  const nextOffset = offset + pageSize;
  const nextCursor = nextOffset < items.length ? encodeCursor(nextOffset) : undefined;
  return { items: slice, nextCursor };
}

// ─── URI 模板编译/匹配 ─────────────────────────────────

/** 变量名合法字符:[A-Za-z_][A-Za-z0-9_]* */
const VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 占位符正则:匹配 {varName} */
const PLACEHOLDER_RE = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * 编译 URI 模板为正则 + 变量名列表
 *
 * - `file://docs/{path}` → regex `^file://docs/(.+)$`, paramNames `['path']`
 * - `git://repo/{owner}/{repo}` → regex `^git://repo/([^/]+)/([^/]+)$`, paramNames `['owner', 'repo']`
 *
 * 约束:
 * - 模板必须有至少一个 `{var}` 占位符
 * - 不支持 RFC 6570 操作符前缀(`{+var}`、`{?var}`、`{/var}` 等)
 * - 单变量贪婪匹配到 URI 结尾(允许包含 `/`)
 * - 多变量非贪婪匹配(不含 `/`),避免歧义
 *
 * @throws Error 模板格式无效
 */
function compileUriTemplate(uriTemplate: string): { regex: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  // 收集变量名并校验
  let match: RegExpExecArray | null;
  PLACEHOLDER_RE.lastIndex = 0;
  while ((match = PLACEHOLDER_RE.exec(uriTemplate)) !== null) {
    const name = match[1]!;
    if (!VAR_NAME_RE.test(name)) {
      throw new Error(`Invalid URI template variable name: ${name}`);
    }
    paramNames.push(name);
  }
  if (paramNames.length === 0) {
    throw new Error(`URI template must contain at least one {var} placeholder: ${uriTemplate}`);
  }

  // 检查重复变量名
  const seen = new Set<string>();
  for (const name of paramNames) {
    if (seen.has(name)) {
      throw new Error(`Duplicate URI template variable: ${name}`);
    }
    seen.add(name);
  }

  // 构建正则:转义字面字符,替换占位符
  // 单变量时贪婪(允许 /),多变量时非贪婪(不含 /)
  const isSingle = paramNames.length === 1;
  // 分段构建:按 {var} 分割,字面部分转义,占位符替换为捕获组
  const parts: string[] = [];
  let lastIdx = 0;
  PLACEHOLDER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PLACEHOLDER_RE.exec(uriTemplate)) !== null) {
    // 转义字面部分
    const literal = uriTemplate.slice(lastIdx, m.index);
    parts.push(escapeRegex(literal));
    // 替换占位符为捕获组
    parts.push(isSingle ? '(.+)' : '([^/]+)');
    lastIdx = m.index + m[0]!.length;
  }
  // 尾部字面部分
  parts.push(escapeRegex(uriTemplate.slice(lastIdx)));
  const regex = new RegExp(`^${parts.join('')}$`);
  return { regex, paramNames };
}

/** 转义正则字面字符 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 用编译后的模板匹配 URI,提取参数
 *
 * @returns 匹配成功返回 params 对象,失败返回 null
 */
function matchUriTemplate(
  regex: RegExp,
  paramNames: string[],
  uri: string,
): Record<string, string> | null {
  const m = regex.exec(uri);
  if (!m) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < paramNames.length; i++) {
    params[paramNames[i]!] = m[i + 1]!;
  }
  return params;
}

// ─── McpServer ──────────────────────────────────────────

export class McpServer {
  private tools = new Map<string, RegisteredTool>();
  private resources = new Map<string, RegisteredResource>();
  private resourceTemplates = new Map<string, RegisteredResourceTemplate>();
  private prompts = new Map<string, RegisteredPrompt>();
  private completions = new Map<string, RegisteredCompletion>();
  private methods = new Map<string, RegisteredMethod>();
  private sessions: SessionManager;
  private readonly pageSize: number;
  private readonly toolsListChanged: boolean;
  private readonly resourcesListChanged: boolean;
  private readonly promptsListChanged: boolean;

  constructor(private options: McpServerOptions) {
    this.sessions = new SessionManager(this.options.sessionTtl);
    this.pageSize = this.options.defaultPageSize ?? DEFAULT_PAGE_SIZE;
    this.toolsListChanged = this.options.toolsListChanged ?? false;
    this.resourcesListChanged = this.options.resourcesListChanged ?? false;
    this.promptsListChanged = this.options.promptsListChanged ?? false;
  }

  /** 注册 tool */
  tool(name: string, definition: McpToolDefinition): void {
    if (this.tools.has(name)) {
      throw new Error(`Tool "${name}" is already registered`);
    }
    let inputSchema: z.ZodObject<Record<string, z.ZodType>> | undefined;
    let jsonSchema: Record<string, unknown> | undefined;

    if (definition.input) {
      // 将 raw shape 包装为 z.object
      inputSchema = buildZodObject(definition.input);
      // 转为 JSON Schema（MCP 协议要求）
      jsonSchema = toJSONSchema(inputSchema, { target: 'draft-7' }) as Record<string, unknown>;
      // 移除 $schema 字段（MCP 规范不需要）
      delete jsonSchema.$schema;
      // 移除 additionalProperties: false（MCP 客户端兼容性）
      delete jsonSchema.additionalProperties;
    }

    this.tools.set(name, { name, definition, inputSchema, jsonSchema });
  }

  /** 注册 resource */
  resource(uri: string, definition: McpResourceDefinition): void {
    if (this.resources.has(uri)) {
      throw new Error(`Resource "${uri}" is already registered`);
    }
    this.resources.set(uri, { uri, definition });
  }

  /** 注册 resource template(RFC 6570 URI 模板) */
  resourceTemplate(uriTemplate: string, definition: McpResourceTemplateDefinition): void {
    if (this.resourceTemplates.has(uriTemplate)) {
      throw new Error(`Resource template "${uriTemplate}" is already registered`);
    }
    const { regex, paramNames } = compileUriTemplate(uriTemplate);
    this.resourceTemplates.set(uriTemplate, {
      uriTemplate,
      regex,
      paramNames,
      definition,
    });
  }

  /** 注册 prompt */
  prompt(name: string, definition: McpPromptDefinition): void {
    if (this.prompts.has(name)) {
      throw new Error(`Prompt "${name}" is already registered`);
    }
    this.prompts.set(name, { name, definition });
  }

  /**
   * 注册参数补全 handler
   *
   * - `ref`:`{ type: 'ref/prompt', name }` 或 `{ type: 'ref/resource', uri }`(对资源模板,uri 是模板字符串)
   * - `argumentName`:补全的参数名(对应 prompt arguments 中的 name,或 resource template URI 模板中的变量名)
   * - 同一 (ref, argumentName) 重复注册抛错
   */
  completion(ref: CompletionRef, argumentName: string, handler: CompletionHandler): void {
    const refType = ref.type;
    const refId = refType === 'ref/prompt' ? ref.name : ref.uri;
    const key = completionKey(refType, refId, argumentName);
    if (this.completions.has(key)) {
      throw new Error(
        `Completion for ${refType} "${refId}" argument "${argumentName}" is already registered`,
      );
    }
    this.completions.set(key, { refType, refId, argumentName, handler });
  }

  /**
   * 注册自定义 JSON-RPC 方法 handler(业务拓展)
   *
   * - 方法名建议使用 `appName/action` 格式,避免与 MCP 标准方法冲突
   * - 与 MCP 内置方法(initialize/ping/tools/* 等)冲突时抛错
   * - 重复注册同名方法抛错
   *
   * handler 返回值规则:
   * - 返回普通对象:作为 JSON-RPC result 字段
   * - 返回 JsonRpcErrorResponse(含 error 字段):作为错误响应
   */
  method(name: string, handler: MethodHandler): void {
    if (BUILTIN_METHODS.has(name)) {
      throw new Error(`Cannot register built-in method "${name}": it is reserved by MCP protocol`);
    }
    if (this.methods.has(name)) {
      throw new Error(`Method "${name}" is already registered`);
    }
    this.methods.set(name, { name, handler });
  }

  /** 获取已注册 tool 名称列表 */
  listTools(): string[] {
    return [...this.tools.keys()];
  }

  /** 获取已注册 resource URI 列表 */
  listResources(): string[] {
    return [...this.resources.keys()];
  }

  /** 获取已注册 prompt 名称列表 */
  listPrompts(): string[] {
    return [...this.prompts.keys()];
  }

  /** 获取已注册自定义方法名列表(业务拓展) */
  listMethods(): string[] {
    return [...this.methods.keys()];
  }

  // ─── remove 方法(运行时删除注册项) ───────────────────

  /**
   * 删除已注册 tool
   *
   * - `toolsListChanged: true` 时自动推送 `notifications/tools/list_changed`
   * - `toolsListChanged: false` 时静默删除(用于 dev 热替换,客户端不感知)
   */
  removeTool(name: string): boolean {
    const deleted = this.tools.delete(name);
    if (deleted && this.toolsListChanged) {
      this.notifyToolsListChanged();
    }
    return deleted;
  }

  /**
   * 删除已注册 resource
   *
   * - `resourcesListChanged: true` 时自动推送 `notifications/resources/list_changed`
   */
  removeResource(uri: string): boolean {
    const deleted = this.resources.delete(uri);
    if (deleted && this.resourcesListChanged) {
      this.notifyResourcesListChanged();
    }
    return deleted;
  }

  /**
   * 删除已注册 resource template
   *
   * - `resourcesListChanged: true` 时自动推送 `notifications/resources/list_changed`
   */
  removeResourceTemplate(uriTemplate: string): boolean {
    const deleted = this.resourceTemplates.delete(uriTemplate);
    if (deleted && this.resourcesListChanged) {
      this.notifyResourcesListChanged();
    }
    return deleted;
  }

  /**
   * 删除已注册 prompt
   *
   * - `promptsListChanged: true` 时自动推送 `notifications/prompts/list_changed`
   */
  removePrompt(name: string): boolean {
    const deleted = this.prompts.delete(name);
    if (deleted && this.promptsListChanged) {
      this.notifyPromptsListChanged();
    }
    return deleted;
  }

  /**
   * 删除已注册 completion handler
   *
   * - completion 无 list_changed 通知机制(客户端按需请求,无需感知列表变化)
   */
  removeCompletion(ref: CompletionRef, argumentName: string): boolean {
    const refType = ref.type;
    const refId = refType === 'ref/prompt' ? ref.name : ref.uri;
    const key = completionKey(refType, refId, argumentName);
    return this.completions.delete(key);
  }

  /** 删除已注册自定义方法 */
  removeMethod(name: string): boolean {
    return this.methods.delete(name);
  }

  // ─── list_changed 通知 ───────────────────────────────

  /**
   * 推送 `notifications/tools/list_changed` 到所有 session 的 SSE 订阅者
   *
   * 客户端收到后应重新调用 `tools/list` 拉取最新列表。
   * `removeTool` 在 `toolsListChanged: true` 时自动调用本方法,
   * 业务方也可手动调用(如批量删除后只推送一次)。
   */
  notifyToolsListChanged(): void {
    this.broadcastNotificationToAllSessions('notifications/tools/list_changed');
  }

  /** 推送 `notifications/resources/list_changed` 到所有 session 的 SSE 订阅者 */
  notifyResourcesListChanged(): void {
    this.broadcastNotificationToAllSessions('notifications/resources/list_changed');
  }

  /** 推送 `notifications/prompts/list_changed` 到所有 session 的 SSE 订阅者 */
  notifyPromptsListChanged(): void {
    this.broadcastNotificationToAllSessions('notifications/prompts/list_changed');
  }

  /**
   * 向所有 session 的所有 SSE 订阅者广播通知(内部工具方法)
   *
   * 用于 list_changed 这种"全局广播"语义——所有 session 都应感知列表变化。
   */
  private broadcastNotificationToAllSessions(method: string, params?: unknown): void {
    const notification: { jsonrpc: '2.0'; method: string; params?: unknown } = {
      jsonrpc: '2.0',
      method,
    };
    if (params !== undefined) {
      notification.params = params;
    }
    const sseData = `data: ${JSON.stringify(notification)}\n\n`;
    for (const sessionId of this.sessions.allSessionIds()) {
      this.sessions.broadcastToSession(sessionId, sseData);
    }
  }

  /** 获取会话管理器 */
  getSessionManager(): SessionManager {
    return this.sessions;
  }

  /** 获取 GET SSE 流心跳间隔(毫秒) */
  getSseHeartbeatMs(): number {
    return this.options.sseHeartbeatMs ?? 30_000;
  }

  /**
   * 处理 JSON-RPC 请求，返回响应消息
   *
   * 通知（无 id）不返回响应，返回 null。
   */
  async handleJsonRpc(
    message: JsonRpcMessage,
    session: McpSession | undefined,
  ): Promise<JsonRpcMessage | null> {
    // 通知：无响应
    if (isNotification(message)) {
      return this.handleNotification(message, session);
    }

    // 请求：必须有 id
    if ('id' in message && 'method' in message && !('result' in message) && !('error' in message)) {
      return this.handleRequest(message, session);
    }

    // 其他消息类型（response 等）：忽略
    return null;
  }

  private handleNotification(
    message: { method: string; params?: unknown },
    session: McpSession | undefined,
  ): null {
    switch (message.method) {
      case 'notifications/initialized':
        if (session) session.initialized = true;
        break;
      case 'notifications/cancelled':
        // 请求取消——v1 不实现取消逻辑，仅接收
        break;
    }
    return null;
  }

  private async handleRequest(
    request: JsonRpcRequest,
    session: McpSession | undefined,
  ): Promise<JsonRpcMessage> {
    try {
      switch (request.method) {
        case 'initialize':
          return this.handleInitialize(request, session);

        case 'ping':
          return createResultResponse(request.id, {});

        case 'tools/list':
          return this.handleToolsList(request);

        case 'tools/call':
          return await this.handleToolsCall(request, session);

        case 'resources/list':
          return this.handleResourcesList(request);

        case 'resources/read':
          return await this.handleResourcesRead(request, session);

        case 'prompts/list':
          return this.handlePromptsList(request);

        case 'prompts/get':
          return await this.handlePromptsGet(request, session);

        case 'logging/setLevel':
          return this.handleLoggingSetLevel(request, session);

        case 'resources/subscribe':
          return this.handleResourcesSubscribe(request, session);

        case 'resources/unsubscribe':
          return this.handleResourcesUnsubscribe(request, session);

        case 'resources/templates/list':
          return this.handleResourcesTemplatesList(request);

        case 'completion/complete':
          return await this.handleCompletionComplete(request);

        default:
          // 自定义方法分发(业务拓展)
          if (this.methods.has(request.method)) {
            return await this.handleCustomMethod(request, session);
          }
          return createErrorResponse(
            request.id,
            ErrorCode.MethodNotFound,
            `Method not found: ${request.method}`,
          );
      }
    } catch (err) {
      return createErrorResponse(
        request.id,
        ErrorCode.InternalError,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // ─── initialize ──────────────────────────────────────

  private handleInitialize(
    request: JsonRpcRequest,
    session: McpSession | undefined,
  ): JsonRpcMessage {
    const params = (request.params ?? {}) as {
      protocolVersion?: string;
      clientInfo?: { name: string; version: string };
    };

    // 协议版本协商
    const requestedVersion = params.protocolVersion ?? PROTOCOL_VERSION;
    const protocolVersion = (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(
      requestedVersion,
    )
      ? requestedVersion
      : PROTOCOL_VERSION;

    // 如果没有 session（直接调用 handleJsonRpc，非 transport 场景），创建一个
    // transport 层已创建 session 时则复用
    if (!session) {
      session = this.sessions.create();
    }
    session.protocolVersion = protocolVersion;
    session.clientInfo = params.clientInfo;

    // capability 根据实际注册情况动态生成
    const capabilities: Record<string, unknown> = {
      tools: { listChanged: this.toolsListChanged },
      // logging capability 始终声明——服务端内置日志推送能力
      logging: {},
    };
    if (this.resources.size > 0 || this.resourceTemplates.size > 0) {
      // 注册了 resource 或 resource template 时声明 resources capability + subscribe 子能力
      capabilities.resources = { listChanged: this.resourcesListChanged, subscribe: true };
    }
    if (this.prompts.size > 0) {
      capabilities.prompts = { listChanged: this.promptsListChanged };
    }

    const result = {
      protocolVersion,
      capabilities,
      serverInfo: {
        name: this.options.name,
        version: this.options.version,
        ...(this.options.title && { title: this.options.title }),
      },
      ...(this.options.instructions && { instructions: this.options.instructions }),
    };

    return createResultResponse(request.id, result);
  }

  // ─── tools/list ──────────────────────────────────────

  private handleToolsList(request: JsonRpcRequest): JsonRpcMessage {
    const params = (request.params ?? {}) as { cursor?: string };
    const allTools = Array.from(this.tools.values()).map((tool) => ({
      name: tool.name,
      ...(tool.definition.description && { description: tool.definition.description }),
      inputSchema: tool.jsonSchema ?? { type: 'object', properties: {} },
      ...(tool.definition.annotations && { annotations: tool.definition.annotations }),
    }));

    let paged: { items: typeof allTools; nextCursor?: string };
    try {
      paged = paginate(allTools, params.cursor, this.pageSize);
    } catch (err) {
      return createErrorResponse(
        request.id,
        ErrorCode.InvalidParams,
        err instanceof Error ? err.message : 'Invalid cursor',
      );
    }

    return createResultResponse(request.id, {
      tools: paged.items,
      ...(paged.nextCursor && { nextCursor: paged.nextCursor }),
    });
  }

  // ─── tools/call ──────────────────────────────────────

  private async handleToolsCall(
    request: JsonRpcRequest,
    session: McpSession | undefined,
  ): Promise<JsonRpcMessage> {
    const params = (request.params ?? {}) as {
      name?: string;
      arguments?: Record<string, unknown>;
      _meta?: { progressToken?: unknown };
    };

    if (!params.name) {
      return createErrorResponse(
        request.id,
        ErrorCode.InvalidParams,
        'Missing required parameter: name',
      );
    }

    const tool = this.tools.get(params.name);
    if (!tool) {
      return createErrorResponse(
        request.id,
        ErrorCode.InvalidParams,
        `Unknown tool: ${params.name}`,
      );
    }

    // 校验输入参数
    const args = params.arguments ?? {};
    if (tool.inputSchema) {
      const parsed = tool.inputSchema.safeParse(args);
      if (!parsed.success) {
        return createErrorResponse(
          request.id,
          ErrorCode.InvalidParams,
          'Invalid tool arguments',
          parsed.error.issues,
        );
      }
      // 使用解析后的值（含默认值、coerce 等）
      Object.assign(args, parsed.data);
    }

    // 从请求 _meta.progressToken 提取进度 token(任意 JSON 值)
    const progressToken = params._meta?.progressToken;

    // 调用 handler
    const extra: ToolCallExtra = {
      sessionId: session?.id ?? '',
      sendLogging: (level, data, logger) => {
        if (session) this.sendLogging(session.id, level, data, logger);
      },
      sendProgress: (progress, total) => {
        if (session) this.sendProgress(session.id, progressToken, progress, total);
      },
    };

    let result: McpToolResult;
    try {
      result = await tool.definition.handler(args as Record<string, unknown>, extra);
    } catch (err) {
      // tool 执行错误——返回 isError 而非协议错误
      result = {
        content: [
          {
            type: 'text',
            text: `Tool execution failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }

    return createResultResponse(request.id, result);
  }

  // ─── resources/list ─────────────────────────────────

  private handleResourcesList(request: JsonRpcRequest): JsonRpcMessage {
    const params = (request.params ?? {}) as { cursor?: string };
    const allResources = Array.from(this.resources.values()).map((r) => ({
      uri: r.uri,
      name: r.definition.name,
      ...(r.definition.description && { description: r.definition.description }),
      ...(r.definition.mimeType && { mimeType: r.definition.mimeType }),
    }));

    let paged: { items: typeof allResources; nextCursor?: string };
    try {
      paged = paginate(allResources, params.cursor, this.pageSize);
    } catch (err) {
      return createErrorResponse(
        request.id,
        ErrorCode.InvalidParams,
        err instanceof Error ? err.message : 'Invalid cursor',
      );
    }

    return createResultResponse(request.id, {
      resources: paged.items,
      ...(paged.nextCursor && { nextCursor: paged.nextCursor }),
    });
  }

  // ─── resources/read ─────────────────────────────────

  private async handleResourcesRead(
    request: JsonRpcRequest,
    session: McpSession | undefined,
  ): Promise<JsonRpcMessage> {
    const params = (request.params ?? {}) as {
      uri?: string;
      _meta?: { progressToken?: unknown };
    };

    if (!params.uri) {
      return createErrorResponse(
        request.id,
        ErrorCode.InvalidParams,
        'Missing required parameter: uri',
      );
    }

    // 从请求 _meta.progressToken 提取进度 token(任意 JSON 值)
    const progressToken = params._meta?.progressToken;

    // sendProgress 闭包(精确匹配与模板匹配共用,捕获 progressToken)
    const sendProgressFn: SendProgressFn = (progress, total) => {
      if (session) this.sendProgress(session.id, progressToken, progress, total);
    };

    const extra: ResourceReadExtra = {
      sessionId: session?.id ?? '',
      sendLogging: (level, data, logger) => {
        if (session) this.sendLogging(session.id, level, data, logger);
      },
      sendProgress: sendProgressFn,
    };

    // 1. 先在 resources Map 中查找精确匹配
    const resource = this.resources.get(params.uri);
    if (resource) {
      const result = await resource.definition.read(params.uri, extra);
      return createResultResponse(request.id, result);
    }

    // 2. 找不到时,遍历 resourceTemplates 用 URI 模板匹配
    for (const tpl of this.resourceTemplates.values()) {
      const params2 = matchUriTemplate(tpl.regex, tpl.paramNames, params.uri);
      if (params2) {
        const tplExtra: ResourceTemplateReadExtra = {
          sessionId: session?.id ?? '',
          sendLogging: (level, data, logger) => {
            if (session) this.sendLogging(session.id, level, data, logger);
          },
          sendProgress: sendProgressFn,
        };
        const result = await tpl.definition.read(params.uri, params2, tplExtra);
        return createResultResponse(request.id, result);
      }
    }

    // 3. 都不匹配
    return createErrorResponse(
      request.id,
      ErrorCode.InvalidParams,
      `Unknown resource: ${params.uri}`,
    );
  }

  // ─── resources/templates/list ──────────────────────

  private handleResourcesTemplatesList(request: JsonRpcRequest): JsonRpcMessage {
    const params = (request.params ?? {}) as { cursor?: string };
    const allTemplates = Array.from(this.resourceTemplates.values()).map((t) => ({
      uriTemplate: t.uriTemplate,
      name: t.definition.name,
      ...(t.definition.description && { description: t.definition.description }),
      ...(t.definition.mimeType && { mimeType: t.definition.mimeType }),
    }));

    let paged: { items: typeof allTemplates; nextCursor?: string };
    try {
      paged = paginate(allTemplates, params.cursor, this.pageSize);
    } catch (err) {
      return createErrorResponse(
        request.id,
        ErrorCode.InvalidParams,
        err instanceof Error ? err.message : 'Invalid cursor',
      );
    }

    return createResultResponse(request.id, {
      resourceTemplates: paged.items,
      ...(paged.nextCursor && { nextCursor: paged.nextCursor }),
    });
  }

  // ─── prompts/list ───────────────────────────────────

  private handlePromptsList(request: JsonRpcRequest): JsonRpcMessage {
    const params = (request.params ?? {}) as { cursor?: string };
    const allPrompts = Array.from(this.prompts.values()).map((p) => ({
      name: p.name,
      ...(p.definition.description && { description: p.definition.description }),
      ...(p.definition.arguments && { arguments: p.definition.arguments }),
    }));

    let paged: { items: typeof allPrompts; nextCursor?: string };
    try {
      paged = paginate(allPrompts, params.cursor, this.pageSize);
    } catch (err) {
      return createErrorResponse(
        request.id,
        ErrorCode.InvalidParams,
        err instanceof Error ? err.message : 'Invalid cursor',
      );
    }

    return createResultResponse(request.id, {
      prompts: paged.items,
      ...(paged.nextCursor && { nextCursor: paged.nextCursor }),
    });
  }

  // ─── prompts/get ────────────────────────────────────

  private async handlePromptsGet(
    request: JsonRpcRequest,
    session: McpSession | undefined,
  ): Promise<JsonRpcMessage> {
    const params = (request.params ?? {}) as {
      name?: string;
      arguments?: Record<string, string>;
      _meta?: { progressToken?: unknown };
    };

    if (!params.name) {
      return createErrorResponse(
        request.id,
        ErrorCode.InvalidParams,
        'Missing required parameter: name',
      );
    }

    const prompt = this.prompts.get(params.name);
    if (!prompt) {
      return createErrorResponse(
        request.id,
        ErrorCode.InvalidParams,
        `Unknown prompt: ${params.name}`,
      );
    }

    // 从请求 _meta.progressToken 提取进度 token(任意 JSON 值)
    const progressToken = params._meta?.progressToken;

    const extra: PromptGetExtra = {
      sessionId: session?.id ?? '',
      sendLogging: (level, data, logger) => {
        if (session) this.sendLogging(session.id, level, data, logger);
      },
      sendProgress: (progress, total) => {
        if (session) this.sendProgress(session.id, progressToken, progress, total);
      },
    };

    const args = params.arguments ?? {};
    const result = await prompt.definition.get(args, extra);
    return createResultResponse(request.id, result);
  }

  // ─── logging/setLevel ──────────────────────────────

  private handleLoggingSetLevel(
    request: JsonRpcRequest,
    session: McpSession | undefined,
  ): JsonRpcMessage {
    const params = (request.params ?? {}) as { level?: string };
    if (!params.level) {
      return createErrorResponse(
        request.id,
        ErrorCode.InvalidParams,
        'Missing required parameter: level',
      );
    }
    const validLevels: readonly LoggingLevel[] = [
      'debug',
      'info',
      'notice',
      'warning',
      'error',
      'critical',
      'alert',
      'emergency',
    ];
    if (!validLevels.includes(params.level as LoggingLevel)) {
      return createErrorResponse(
        request.id,
        ErrorCode.InvalidParams,
        `Invalid logging level: ${params.level}`,
      );
    }
    if (session) {
      session.loggingLevel = params.level as LoggingLevel;
    }
    return createResultResponse(request.id, {});
  }

  // ─── resources/subscribe ───────────────────────────

  private handleResourcesSubscribe(
    request: JsonRpcRequest,
    session: McpSession | undefined,
  ): JsonRpcMessage {
    const params = (request.params ?? {}) as { uri?: string };
    if (!params.uri) {
      return createErrorResponse(
        request.id,
        ErrorCode.InvalidParams,
        'Missing required parameter: uri',
      );
    }
    if (!session) {
      return createErrorResponse(request.id, ErrorCode.InvalidRequest, 'No session for subscribe');
    }
    this.sessions.subscribeResource(session.id, params.uri);
    return createResultResponse(request.id, {});
  }

  // ─── resources/unsubscribe ─────────────────────────

  private handleResourcesUnsubscribe(
    request: JsonRpcRequest,
    session: McpSession | undefined,
  ): JsonRpcMessage {
    const params = (request.params ?? {}) as { uri?: string };
    if (!params.uri) {
      return createErrorResponse(
        request.id,
        ErrorCode.InvalidParams,
        'Missing required parameter: uri',
      );
    }
    if (!session) {
      return createErrorResponse(
        request.id,
        ErrorCode.InvalidRequest,
        'No session for unsubscribe',
      );
    }
    this.sessions.unsubscribeResource(session.id, params.uri);
    return createResultResponse(request.id, {});
  }

  // ─── completion/complete ───────────────────────────

  private async handleCompletionComplete(request: JsonRpcRequest): Promise<JsonRpcMessage> {
    const params = (request.params ?? {}) as {
      ref?: { type: string; name?: string; uri?: string };
      argument?: { name?: string; value?: string };
      arguments?: Record<string, string>;
    };

    if (!params.ref || !params.argument) {
      return createErrorResponse(
        request.id,
        ErrorCode.InvalidParams,
        'Missing required parameter: ref and argument',
      );
    }

    const ref = params.ref;
    let refType: 'ref/prompt' | 'ref/resource';
    let refId: string;
    if (ref.type === 'ref/prompt' && typeof ref.name === 'string') {
      refType = 'ref/prompt';
      refId = ref.name;
    } else if (ref.type === 'ref/resource' && typeof ref.uri === 'string') {
      refType = 'ref/resource';
      refId = ref.uri;
    } else {
      return createErrorResponse(
        request.id,
        ErrorCode.InvalidParams,
        `Invalid ref: ${JSON.stringify(ref)}`,
      );
    }

    if (typeof params.argument.name !== 'string') {
      return createErrorResponse(
        request.id,
        ErrorCode.InvalidParams,
        'Missing required parameter: argument.name',
      );
    }

    const key = completionKey(refType, refId, params.argument.name);
    const completion = this.completions.get(key);
    if (!completion) {
      return createErrorResponse(
        request.id,
        ErrorCode.MethodNotFound,
        `No completion handler for ${refType} "${refId}" argument "${params.argument.name}"`,
      );
    }

    const value = params.argument.value ?? '';
    const context: CompletionContext = {
      arguments: params.arguments ?? {},
    };

    let result: CompletionResult;
    try {
      result = await completion.handler(value, context);
    } catch (err) {
      return createErrorResponse(
        request.id,
        ErrorCode.InternalError,
        err instanceof Error ? err.message : String(err),
      );
    }

    return createResultResponse(request.id, { completion: result });
  }

  // ─── 自定义方法分发(业务拓展) ───────────────────────

  private async handleCustomMethod(
    request: JsonRpcRequest,
    session: McpSession | undefined,
  ): Promise<JsonRpcMessage> {
    const registered = this.methods.get(request.method);
    if (!registered) {
      // 双重检查(并发场景下可能在 default 分支后已被 remove)
      return createErrorResponse(
        request.id,
        ErrorCode.MethodNotFound,
        `Method not found: ${request.method}`,
      );
    }

    const extra: RequestExtra = {
      sessionId: session?.id ?? '',
      sendLogging: (level, data, logger) => {
        if (session) this.sendLogging(session.id, level, data, logger);
      },
      sendProgress: (progress, total) => {
        // 自定义方法无 progressToken 来源,始终传 undefined(业务方可直接用 server.sendProgress)
        if (session) this.sendProgress(session.id, undefined, progress, total);
      },
    };

    let result: MethodHandlerResult;
    try {
      result = await registered.handler(request.params, session, extra);
    } catch (err) {
      return createErrorResponse(
        request.id,
        ErrorCode.InternalError,
        err instanceof Error ? err.message : String(err),
      );
    }

    // 返回 JsonRpcErrorResponse 表示业务错误
    if (
      result !== null &&
      typeof result === 'object' &&
      'error' in result &&
      result.error !== null &&
      typeof result.error === 'object'
    ) {
      // 已是错误响应格式——补全 id 后返回
      const errResp = result as unknown as JsonRpcErrorResponse;
      return { ...errResp, jsonrpc: '2.0', id: request.id };
    }

    // 普通对象——作为 result 返回
    return createResultResponse(request.id, result);
  }

  // ─── sendLogging(应用级 + handler extra 共用) ─────

  /**
   * 推送 notifications/message 到 session 的所有 SSE 订阅者
   *
   * - 无 session 或无订阅者:静默丢弃
   * - level 低于 session.loggingLevel:静默丢弃
   * - SSE 行格式:`data: ${JSON.stringify(notification)}\n\n`
   */
  sendLogging(sessionId: string, level: LoggingLevel, data: unknown, logger?: string): void {
    if (!this.sessions.shouldLog(sessionId, level)) return;
    const notification: { jsonrpc: '2.0'; method: string; params: Record<string, unknown> } = {
      jsonrpc: '2.0',
      method: 'notifications/message',
      params: { level, data },
    };
    if (logger !== undefined) {
      notification.params.logger = logger;
    }
    const sseData = `data: ${JSON.stringify(notification)}\n\n`;
    this.sessions.broadcastToSession(sessionId, sseData);
  }

  /**
   * 推送 notifications/resources/updated 到所有订阅了该 URI 的 session
   *
   * - 找出所有 subscribedResources 包含该 URI 的 session
   * - 对每个 session 的所有 SSE 订阅者推送通知
   * - 无订阅者的 session 静默跳过
   */
  sendResourceUpdated(uri: string): void {
    const sessionIds = this.sessions.findSubscribersOfUri(uri);
    if (sessionIds.length === 0) return;
    const notification = {
      jsonrpc: '2.0' as const,
      method: 'notifications/resources/updated',
      params: { uri },
    };
    const sseData = `data: ${JSON.stringify(notification)}\n\n`;
    for (const sessionId of sessionIds) {
      this.sessions.broadcastToSession(sessionId, sseData);
    }
  }

  /**
   * 推送 notifications/progress 到 session 的所有 SSE 订阅者
   *
   * - 无 session 或无订阅者:静默丢弃
   * - progressToken 为 undefined/null:静默丢弃(无法关联进度与请求)
   *
   * @param sessionId 会话 ID
   * @param progressToken 客户端在请求 _meta.progressToken 中传入的 token(任意 JSON 值)
   * @param progress 当前进度(数值)
   * @param total 总数(可选)
   */
  sendProgress(sessionId: string, progressToken: unknown, progress: number, total?: number): void {
    if (progressToken === undefined || progressToken === null) return;
    const params: Record<string, unknown> = { progressToken, progress };
    if (total !== undefined) {
      params.total = total;
    }
    const notification = {
      jsonrpc: '2.0' as const,
      method: 'notifications/progress',
      params,
    };
    const sseData = `data: ${JSON.stringify(notification)}\n\n`;
    this.sessions.broadcastToSession(sessionId, sseData);
  }

  /**
   * 通用通知推送(业务拓展)——向指定 session 的所有 SSE 订阅者推送任意通知
   *
   * - 无 session 或无订阅者:静默丢弃
   * - 不校验 method 是否符合 MCP 规范——业务方自行负责
   * - SSE 行格式:`data: ${JSON.stringify(notification)}\n\n`
   *
   * @param sessionId 目标 session ID
   * @param method 通知方法名(如 `notifications/myapp/sync`)
   * @param params 通知参数(可选)
   */
  sendNotification(sessionId: string, method: string, params?: unknown): void {
    const notification: { jsonrpc: '2.0'; method: string; params?: unknown } = {
      jsonrpc: '2.0',
      method,
    };
    if (params !== undefined) {
      notification.params = params;
    }
    const sseData = `data: ${JSON.stringify(notification)}\n\n`;
    this.sessions.broadcastToSession(sessionId, sseData);
  }
}

// ─── 工具函数 ───────────────────────────────────────────

/**
 * 将 raw shape（{ key: z.ZodType }）包装为 z.object
 */
function buildZodObject(shape: Record<string, z.ZodType>): z.ZodObject<Record<string, z.ZodType>> {
  return z.object(shape);
}

/**
 * 生成 completion Map 的键
 *
 * 形如 `ref/prompt:greet:userName` 或 `ref/resource:file://docs/{path}:path`
 */
function completionKey(
  refType: 'ref/prompt' | 'ref/resource',
  refId: string,
  argumentName: string,
): string {
  return `${refType}:${refId}:${argumentName}`;
}

// ─── 工厂函数 ───────────────────────────────────────────

export function createMcpServer(options: McpServerOptions): McpServer {
  return new McpServer(options);
}
