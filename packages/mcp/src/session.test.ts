import { describe, it, expect } from 'vitest';
import { SessionManager } from './session';

describe('SessionManager', () => {
  it('create 创建新会话', () => {
    const sm = new SessionManager();
    const session = sm.create();
    expect(session.id).toBeDefined();
    expect(typeof session.id).toBe('string');
    expect(session.id.length).toBeGreaterThan(0);
    expect(session.initialized).toBe(false);
    expect(session.protocolVersion).toBe('');
    expect(session.createdAt).toBeGreaterThan(0);
  });

  it('每次 create 返回唯一 ID', () => {
    const sm = new SessionManager();
    const s1 = sm.create();
    const s2 = sm.create();
    expect(s1.id).not.toBe(s2.id);
  });

  it('get 按 ID 获取会话', () => {
    const sm = new SessionManager();
    const session = sm.create();
    expect(sm.get(session.id)).toBe(session);
  });

  it('get 不存在的 ID 返回 undefined', () => {
    const sm = new SessionManager();
    expect(sm.get('nonexistent')).toBeUndefined();
  });

  it('has 检查会话是否存在', () => {
    const sm = new SessionManager();
    const session = sm.create();
    expect(sm.has(session.id)).toBe(true);
    expect(sm.has('nonexistent')).toBe(false);
  });

  it('delete 销毁会话', () => {
    const sm = new SessionManager();
    const session = sm.create();
    expect(sm.delete(session.id)).toBe(true);
    expect(sm.has(session.id)).toBe(false);
    expect(sm.get(session.id)).toBeUndefined();
  });

  it('delete 不存在的 ID 返回 false', () => {
    const sm = new SessionManager();
    expect(sm.delete('nonexistent')).toBe(false);
  });

  it('size 返回当前会话数', () => {
    const sm = new SessionManager();
    expect(sm.size).toBe(0);
    sm.create();
    sm.create();
    expect(sm.size).toBe(2);
  });

  it('clear 清空所有会话', () => {
    const sm = new SessionManager();
    sm.create();
    sm.create();
    sm.clear();
    expect(sm.size).toBe(0);
  });

  it('session 可修改 initialized 和 protocolVersion', () => {
    const sm = new SessionManager();
    const session = sm.create();
    session.initialized = true;
    session.protocolVersion = '2025-06-18';
    session.clientInfo = { name: 'test-client', version: '1.0.0' };

    const retrieved = sm.get(session.id);
    expect(retrieved?.initialized).toBe(true);
    expect(retrieved?.protocolVersion).toBe('2025-06-18');
    expect(retrieved?.clientInfo).toEqual({ name: 'test-client', version: '1.0.0' });
  });

  // ─── TTL 过期 ──────────────────────────────────────

  it('TTL 过期后 get 返回 undefined', () => {
    const sm = new SessionManager(100); // 100ms TTL
    const session = sm.create();
    expect(sm.get(session.id)).toBeDefined(); // 未过期

    // 等待过期
    const start = Date.now();
    while (Date.now() - start < 150) {
      // busy wait 150ms
    }

    expect(sm.get(session.id)).toBeUndefined();
  });

  it('TTL 过期后 has 返回 false', () => {
    const sm = new SessionManager(100);
    const session = sm.create();
    expect(sm.has(session.id)).toBe(true);

    const start = Date.now();
    while (Date.now() - start < 150) {
      // busy wait
    }

    expect(sm.has(session.id)).toBe(false);
  });

  it('get 刷新 lastActivity 防止活跃会话过期', () => {
    const sm = new SessionManager(100); // 100ms TTL
    const session = sm.create();

    // 每 50ms get 一次，持续 200ms，不应过期
    for (let i = 0; i < 4; i++) {
      const start = Date.now();
      while (Date.now() - start < 50) {
        // busy wait 50ms
      }
      expect(sm.get(session.id)).toBeDefined();
    }
  });

  it('create 时惰性清理过期会话', () => {
    const sm = new SessionManager(100);
    const old = sm.create();
    expect(sm.size).toBe(1);

    const start = Date.now();
    while (Date.now() - start < 150) {
      // busy wait 等待过期
    }

    // 创建新会话触发清理
    sm.create();
    expect(sm.has(old.id)).toBe(false);
  });

  it('allSessionIds 不含过期会话（惰性清扫）', () => {
    const sm = new SessionManager(50);
    sm.create();
    const start = Date.now();
    while (Date.now() - start < 100) {
      // busy wait 等待过期
    }
    expect(sm.allSessionIds()).toEqual([]);
    expect(sm.size).toBe(0);
  });

  it('findSubscribersOfUri 跳过过期会话', () => {
    const sm = new SessionManager(50);
    const session = sm.create();
    sm.subscribeResource(session.id, 'file:///a');
    const start = Date.now();
    while (Date.now() - start < 100) {
      // busy wait 等待过期
    }
    expect(sm.findSubscribersOfUri('file:///a')).toEqual([]);
  });

  it('broadcastToSession 对过期会话：清扫会话并关闭订阅者，不再投递', () => {
    const sm = new SessionManager(50);
    const session = sm.create();
    // 手动注册一个假订阅者（直接操作 subscribers 集合，避免依赖 addSubscriber 的 get 续期）
    let closed = false;
    const fakeSubscriber = {
      controller: {
        enqueue: () => {},
        close: () => {
          closed = true;
        },
      } as unknown as ReadableStreamDefaultController<Uint8Array>,
      sessionId: session.id,
    };
    session.subscribers.add(fakeSubscriber);

    const start = Date.now();
    while (Date.now() - start < 100) {
      // busy wait 等待过期
    }

    sm.broadcastToSession(session.id, 'data: x\n\n');
    // 广播后立即清扫（不依赖后续 get/has 的惰性检查）：size 归零、订阅者被关闭
    expect(sm.size).toBe(0);
    expect(closed).toBe(true);
  });

  it('broadcastToSession 对活跃会话正常投递', () => {
    const sm = new SessionManager(10_000);
    const session = sm.create();
    const sent: Uint8Array[] = [];
    const fakeSubscriber = {
      controller: {
        enqueue: (chunk: Uint8Array) => sent.push(chunk),
        close: () => {},
      } as unknown as ReadableStreamDefaultController<Uint8Array>,
      sessionId: session.id,
    };
    session.subscribers.add(fakeSubscriber);

    sm.broadcastToSession(session.id, 'data: hello\n\n');
    expect(new TextDecoder().decode(sent[0])).toContain('hello');
  });
});
