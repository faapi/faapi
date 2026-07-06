/**
 * MCP 会话管理
 *
 * Streamable HTTP transport 通过 Mcp-Session-Id header 维持会话。
 * 会话在 initialize 请求时创建，在 DELETE 请求时销毁。
 *
 * 内置 TTL 机制：超过空闲时间的会话自动过期，防止内存泄漏。
 * 惰性清理：在 get/create 时检查过期会话，无需定时器。
 *
 * 每个 session 维护 SSE subscriber 集合,用于服务端主动推送
 * (logging/message, resources/updated, progress 等通知)。
 */

import { randomUUID } from 'node:crypto';

/** 日志级别(syslog 严重度,从低到高) */
export type LoggingLevel =
  | 'debug'
  | 'info'
  | 'notice'
  | 'warning'
  | 'error'
  | 'critical'
  | 'alert'
  | 'emergency';

/** 日志级别数值(越大越严重) */
const LOGGING_LEVEL_ORDER: Record<LoggingLevel, number> = {
  debug: 10,
  info: 20,
  notice: 30,
  warning: 40,
  error: 50,
  critical: 60,
  alert: 70,
  emergency: 80,
};

/** SSE 流订阅者(controller + 关联的 session id) */
export interface SseSubscriber {
  /** SSE 流控制器 */
  controller: ReadableStreamDefaultController<Uint8Array>;
  /** 关联的 session id */
  sessionId: string;
}

export interface McpSession {
  /** 会话 ID（cryptographically secure UUID） */
  id: string;
  /** 是否已完成 initialize 握手 */
  initialized: boolean;
  /** 协商的协议版本 */
  protocolVersion: string;
  /** 客户端信息（来自 initialize 请求） */
  clientInfo?: { name: string; version: string };
  /** 创建时间戳 */
  createdAt: number;
  /** 最后活动时间戳（每次 get 时更新） */
  lastActivity: number;
  /** 当前日志级别(低于此级别的日志不推送),默认 info */
  loggingLevel: LoggingLevel;
  /** SSE 流订阅者集合(GET 流注册,用于服务端主动推送) */
  subscribers: Set<SseSubscriber>;
  /** 已订阅的资源 URI 集合(resources/subscribe 注册) */
  subscribedResources: Set<string>;
}

/** 默认会话空闲超时：30 分钟 */
const DEFAULT_TTL = 30 * 60 * 1000;

/**
 * 内存会话管理器
 *
 * 生产环境如需多实例共享会话，可替换为 Redis 等外部存储实现。
 *
 * @param ttl 会话空闲超时（毫秒），超过此时间未活动的会话自动过期。默认 30 分钟。设为 0 表示永不过期。
 */
export class SessionManager {
  private sessions = new Map<string, McpSession>();
  private readonly ttl: number;

  constructor(ttl: number = DEFAULT_TTL) {
    this.ttl = ttl;
  }

  /** 是否启用 TTL 过期检查(ttl > 0) */
  private get ttlEnabled(): boolean {
    return this.ttl > 0;
  }

  /** 创建新会话，返回 session 对象 */
  create(): McpSession {
    // 惰性清理：创建新会话时顺便清理过期会话
    if (this.ttlEnabled) this.cleanupExpired();

    const now = Date.now();
    const session: McpSession = {
      id: randomUUID(),
      initialized: false,
      protocolVersion: '',
      createdAt: now,
      lastActivity: now,
      loggingLevel: 'info',
      subscribers: new Set(),
      subscribedResources: new Set(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  /** 按 ID 获取会话（更新最后活动时间，过期返回 undefined） */
  get(id: string): McpSession | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;

    // 检查是否过期(ttl=0 时跳过)
    if (this.ttlEnabled && Date.now() - session.lastActivity > this.ttl) {
      this.closeSubscribers(session);
      this.sessions.delete(id);
      return undefined;
    }

    // 更新最后活动时间
    session.lastActivity = Date.now();
    return session;
  }

  /** 是否存在（不更新活动时间，过期会话返回 false） */
  has(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    if (this.ttlEnabled && Date.now() - session.lastActivity > this.ttl) {
      this.closeSubscribers(session);
      this.sessions.delete(id);
      return false;
    }
    return true;
  }

  /** 销毁会话(关闭所有 SSE 订阅者) */
  delete(id: string): boolean {
    const session = this.sessions.get(id);
    if (session) {
      this.closeSubscribers(session);
    }
    return this.sessions.delete(id);
  }

  /** 当前会话数（含可能尚未清理的过期会话） */
  get size(): number {
    return this.sessions.size;
  }

  /** 获取所有 session ID 列表(用于全局广播通知) */
  allSessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  /** 清空所有会话 */
  clear(): void {
    for (const session of this.sessions.values()) {
      this.closeSubscribers(session);
    }
    this.sessions.clear();
  }

  /** 注册 SSE 订阅者到 session */
  addSubscriber(
    sessionId: string,
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): SseSubscriber | undefined {
    const session = this.get(sessionId);
    if (!session) return undefined;
    const subscriber: SseSubscriber = { controller, sessionId };
    session.subscribers.add(subscriber);
    return subscriber;
  }

  /** 注销 SSE 订阅者 */
  removeSubscriber(subscriber: SseSubscriber): void {
    const session = this.sessions.get(subscriber.sessionId);
    if (session) {
      session.subscribers.delete(subscriber);
    }
  }

  /** 向 session 的所有订阅者推送 SSE 数据 */
  broadcastToSession(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const encoder = new TextEncoder();
    for (const sub of session.subscribers) {
      try {
        sub.controller.enqueue(encoder.encode(data));
      } catch {
        // controller 已关闭,移除订阅者
        session.subscribers.delete(sub);
      }
    }
  }

  /** 判断指定级别的日志是否应该推送(>= session.loggingLevel) */
  shouldLog(sessionId: string, level: LoggingLevel): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    return LOGGING_LEVEL_ORDER[level] >= LOGGING_LEVEL_ORDER[session.loggingLevel];
  }

  /** 添加资源订阅(将 uri 加入 session.subscribedResources) */
  subscribeResource(sessionId: string, uri: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.subscribedResources.add(uri);
    return true;
  }

  /** 取消资源订阅(从 session.subscribedResources 移除 uri) */
  unsubscribeResource(sessionId: string, uri: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.subscribedResources.delete(uri);
    return true;
  }

  /** 找出所有订阅了指定 URI 的 session id 列表 */
  findSubscribersOfUri(uri: string): string[] {
    const result: string[] = [];
    for (const session of this.sessions.values()) {
      if (session.subscribedResources.has(uri)) {
        result.push(session.id);
      }
    }
    return result;
  }

  /** 关闭 session 的所有订阅者(用于 session 销毁/过期) */
  private closeSubscribers(session: McpSession): void {
    for (const sub of session.subscribers) {
      try {
        sub.controller.close();
      } catch {
        // controller 已关闭,忽略
      }
    }
    session.subscribers.clear();
  }

  /** 清理所有过期会话 */
  private cleanupExpired(): void {
    if (!this.ttlEnabled) return;
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastActivity > this.ttl) {
        this.closeSubscribers(session);
        this.sessions.delete(id);
      }
    }
  }
}
