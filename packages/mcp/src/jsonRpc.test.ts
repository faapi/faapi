import { describe, it, expect } from 'vitest';
import {
  type JsonRpcMessage,
  isRequest,
  isNotification,
  isResultResponse,
  isErrorResponse,
  createResultResponse,
  createErrorResponse,
  parseJsonRpcMessage,
  JsonRpcParseError,
  ErrorCode,
} from './jsonRpc';

describe('jsonRpc', () => {
  // ─── 消息判定 ─────────────────────────────────────────

  describe('isRequest', () => {
    it('识别有 id 和 method 的请求', () => {
      const msg: JsonRpcMessage = { jsonrpc: '2.0', id: 1, method: 'ping' };
      expect(isRequest(msg)).toBe(true);
    });

    it('拒绝没有 id 的消息', () => {
      const msg: JsonRpcMessage = { jsonrpc: '2.0', method: 'ping' };
      expect(isRequest(msg)).toBe(false);
    });
  });

  describe('isNotification', () => {
    it('识别有 method 但无 id 的通知', () => {
      const msg: JsonRpcMessage = { jsonrpc: '2.0', method: 'notifications/initialized' };
      expect(isNotification(msg)).toBe(true);
    });

    it('拒绝有 id 的消息（那是 request）', () => {
      const msg: JsonRpcMessage = { jsonrpc: '2.0', id: 1, method: 'ping' };
      expect(isNotification(msg)).toBe(false);
    });
  });

  describe('isResultResponse', () => {
    it('识别有 result 和 id 的响应', () => {
      const msg: JsonRpcMessage = { jsonrpc: '2.0', id: 1, result: { ok: true } };
      expect(isResultResponse(msg)).toBe(true);
    });
  });

  describe('isErrorResponse', () => {
    it('识别有 error 和 id 的响应', () => {
      const msg: JsonRpcMessage = {
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32601, message: 'Method not found' },
      };
      expect(isErrorResponse(msg)).toBe(true);
    });
  });

  // ─── 响应构建 ─────────────────────────────────────────

  describe('createResultResponse', () => {
    it('构建成功响应', () => {
      const res = createResultResponse(1, { tools: [] });
      expect(res).toEqual({ jsonrpc: '2.0', id: 1, result: { tools: [] } });
    });

    it('支持字符串 id', () => {
      const res = createResultResponse('abc', null);
      expect(res.id).toBe('abc');
      expect(res.result).toBeNull();
    });
  });

  describe('createErrorResponse', () => {
    it('构建错误响应', () => {
      const res = createErrorResponse(1, ErrorCode.MethodNotFound, 'Method not found');
      expect(res).toEqual({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32601, message: 'Method not found' },
      });
    });

    it('支持 null id（解析错误场景）', () => {
      const res = createErrorResponse(null, ErrorCode.ParseError, 'Parse error');
      expect(res.id).toBeNull();
    });

    it('包含可选 data 字段', () => {
      const res = createErrorResponse(1, ErrorCode.InvalidParams, 'Bad params', { field: 'name' });
      expect(res.error.data).toEqual({ field: 'name' });
    });
  });

  // ─── 消息解析 ─────────────────────────────────────────

  describe('parseJsonRpcMessage', () => {
    it('解析单条请求', () => {
      const msgs = parseJsonRpcMessage({ jsonrpc: '2.0', id: 1, method: 'ping' });
      expect(msgs).toHaveLength(1);
      expect(isRequest(msgs[0]!)).toBe(true);
    });

    it('解析单条通知', () => {
      const msgs = parseJsonRpcMessage({ jsonrpc: '2.0', method: 'notifications/initialized' });
      expect(msgs).toHaveLength(1);
      expect(isNotification(msgs[0]!)).toBe(true);
    });

    it('解析 batch 请求', () => {
      const msgs = parseJsonRpcMessage([
        { jsonrpc: '2.0', id: 1, method: 'ping' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      ]);
      expect(msgs).toHaveLength(2);
    });

    it('解析带 params 的请求', () => {
      const msgs = parseJsonRpcMessage({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'hello', arguments: { x: 1 } },
      });
      expect(msgs).toHaveLength(1);
      expect((msgs[0] as { params?: unknown }).params).toEqual({
        name: 'hello',
        arguments: { x: 1 },
      });
    });

    it('空 batch 数组抛错', () => {
      expect(() => parseJsonRpcMessage([])).toThrow(JsonRpcParseError);
    });

    it('非对象抛错', () => {
      expect(() => parseJsonRpcMessage('hello')).toThrow(JsonRpcParseError);
      expect(() => parseJsonRpcMessage(42)).toThrow(JsonRpcParseError);
      expect(() => parseJsonRpcMessage(null)).toThrow(JsonRpcParseError);
    });

    it('jsonrpc 字段非 "2.0" 抛错', () => {
      expect(() => parseJsonRpcMessage({ jsonrpc: '1.0', id: 1, method: 'ping' })).toThrow(
        JsonRpcParseError,
      );
    });
  });

  // ─── 错误码 ───────────────────────────────────────────

  describe('ErrorCode', () => {
    it('JSON-RPC 标准错误码', () => {
      expect(ErrorCode.ParseError).toBe(-32700);
      expect(ErrorCode.InvalidRequest).toBe(-32600);
      expect(ErrorCode.MethodNotFound).toBe(-32601);
      expect(ErrorCode.InvalidParams).toBe(-32602);
      expect(ErrorCode.InternalError).toBe(-32603);
    });

    it('MCP 扩展错误码', () => {
      expect(ErrorCode.ConnectionClosed).toBe(-32000);
      expect(ErrorCode.RequestTimeout).toBe(-32001);
    });
  });
});
