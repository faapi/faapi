import { describe, it, expect } from 'vitest';
import { wrapWsSocket, type WsHandler, type WsEventHandlers } from './wsHandler';

describe('wsHandler', () => {
  describe('wrapWsSocket', () => {
    it('string 直发：透传给原生 socket', () => {
      const sent: unknown[] = [];
      const raw = {
        send: (data: string | Buffer) => {
          sent.push(data);
        },
        close: () => {},
        readyState: 1,
      };
      const ws = wrapWsSocket(raw);
      ws.send('hello');
      expect(sent).toEqual(['hello']);
    });

    it('Buffer 直发：透传给原生 socket', () => {
      const sent: unknown[] = [];
      const buf = Buffer.from('binary');
      const raw = {
        send: (data: string | Buffer) => {
          sent.push(data);
        },
        close: () => {},
        readyState: 1,
      };
      const ws = wrapWsSocket(raw);
      ws.send(buf);
      expect(sent).toEqual([buf]);
    });

    it('对象 send：自动 JSON.stringify', () => {
      const sent: unknown[] = [];
      const raw = {
        send: (data: string | Buffer) => {
          sent.push(data);
        },
        close: () => {},
        readyState: 1,
      };
      const ws = wrapWsSocket(raw);
      ws.send({ type: 'msg', content: 'hi' });
      expect(sent).toEqual([JSON.stringify({ type: 'msg', content: 'hi' })]);
    });

    it('数组 send：自动 JSON.stringify', () => {
      const sent: unknown[] = [];
      const raw = {
        send: (data: string | Buffer) => {
          sent.push(data);
        },
        close: () => {},
        readyState: 1,
      };
      const ws = wrapWsSocket(raw);
      ws.send([1, 2, 3]);
      expect(sent).toEqual([JSON.stringify([1, 2, 3])]);
    });

    it('close 透传给原生 socket（带 code 和 reason）', () => {
      let closedWith: { code?: number; reason?: string | Buffer } = {};
      const raw = {
        send: () => {},
        close: (code?: number, reason?: string | Buffer) => {
          closedWith = { code, reason };
        },
        readyState: 1,
      };
      const ws = wrapWsSocket(raw);
      ws.close(1000, 'normal');
      expect(closedWith).toEqual({ code: 1000, reason: 'normal' });
    });

    it('close 无参数：透传 undefined', () => {
      let closedWith: { code?: number; reason?: string | Buffer } = {};
      const raw = {
        send: () => {},
        close: (code?: number, reason?: string | Buffer) => {
          closedWith = { code, reason };
        },
        readyState: 1,
      };
      const ws = wrapWsSocket(raw);
      ws.close();
      expect(closedWith).toEqual({ code: undefined, reason: undefined });
    });

    it('readyState 透传原生 socket 状态', () => {
      const raw = {
        send: () => {},
        close: () => {},
        readyState: 1,
      };
      const ws = wrapWsSocket(raw);
      expect(ws.readyState).toBe(1);
      // 修改原生状态后，封装层反映新值
      raw.readyState = 3;
      expect(ws.readyState).toBe(3);
    });

    it('readyState 随原生 socket 实时变化', () => {
      const raw = {
        send: () => {},
        close: () => {},
        readyState: 0,
      };
      const ws = wrapWsSocket(raw);
      expect(ws.readyState).toBe(0); // connecting
      raw.readyState = 1;
      expect(ws.readyState).toBe(1); // open
      raw.readyState = 2;
      expect(ws.readyState).toBe(2); // closing
      raw.readyState = 3;
      expect(ws.readyState).toBe(3); // closed
    });
  });

  describe('WsHandler 类型契约', () => {
    it('返回事件对象：符合 WsEventHandlers', () => {
      const handler: WsHandler = (_ctx) => ({
        onOpen: (_ws) => {},
        onMessage: (_ws, _msg) => {},
        onClose: (_ws, _code, _reason) => {},
        onError: (_ws, _err) => {},
      });
      const result = handler({} as any);
      expect(result).toBeDefined();
      expect(typeof result?.onOpen).toBe('function');
      expect(typeof result?.onMessage).toBe('function');
      expect(typeof result?.onClose).toBe('function');
      expect(typeof result?.onError).toBe('function');
    });

    it('返回部分事件对象：缺省回调为 undefined', () => {
      const handler: WsHandler = (_ctx) => ({
        onMessage: (_ws, _msg) => {},
      });
      const result = handler({} as any) as WsEventHandlers;
      expect(result.onMessage).toBeDefined();
      expect(result.onOpen).toBeUndefined();
      expect(result.onClose).toBeUndefined();
      expect(result.onError).toBeUndefined();
    });

    it('无返回值：void 合法', () => {
      const handler: WsHandler = (_ctx) => {
        // 不返回，仅副作用
      };
      const result = handler({} as any);
      expect(result).toBeUndefined();
    });

    it('事件回调可调用 ws.send', () => {
      const sent: unknown[] = [];
      const raw = {
        send: (data: string | Buffer) => {
          sent.push(data);
        },
        close: () => {},
        readyState: 1,
      };
      const ws = wrapWsSocket(raw);
      const handler: WsHandler = (_ctx) => ({
        onOpen: (socket) => {
          socket.send('welcome');
        },
        onMessage: (socket, msg) => {
          socket.send(`echo: ${msg}`);
        },
      });
      const events = handler({} as any) as WsEventHandlers;
      events.onOpen?.(ws);
      events.onMessage?.(ws, 'ping');
      expect(sent).toEqual(['welcome', 'echo: ping']);
    });
  });
});
