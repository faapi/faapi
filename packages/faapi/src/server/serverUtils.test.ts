import { describe, it, expect } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { nodeHttpToWebHeaders, buildErrorResponse } from './serverUtils';
import { ValidationError } from '../errors/httpErrors';

describe('nodeHttpToWebHeaders', () => {
  it('标量 header 被设置', () => {
    const req = { headers: { 'content-type': 'application/json' } } as unknown as IncomingMessage;
    const h = nodeHttpToWebHeaders(req);
    expect(h.get('content-type')).toBe('application/json');
  });

  it('数组 header 使用 append 逐个追加', () => {
    const req = { headers: { 'set-cookie': ['a=1', 'b=2'] } } as unknown as IncomingMessage;
    const h = nodeHttpToWebHeaders(req);
    expect(h.getSetCookie()).toEqual(['a=1', 'b=2']);
  });

  it('undefined 值被跳过', () => {
    const req = { headers: { 'x-undef': undefined, 'x-set': 'ok' } } as unknown as IncomingMessage;
    const h = nodeHttpToWebHeaders(req);
    expect(h.has('x-undef')).toBe(false);
    expect(h.get('x-set')).toBe('ok');
  });

  it('空 headers 返回空 Headers', () => {
    const req = { headers: {} } as unknown as IncomingMessage;
    const h = nodeHttpToWebHeaders(req);
    expect([...h.entries()]).toHaveLength(0);
  });
});

describe('buildErrorResponse', () => {
  it('普通 Error 使用内置兜底返回 Response', () => {
    const result = buildErrorResponse(new Error('test'));
    expect(result).toBeInstanceOf(Response);
  });

  it('内置兜底对普通 Error 返回 500', () => {
    const result = buildErrorResponse(new Error('boom'));
    expect(result.status).toBe(500);
  });

  it('ValidationError 返回 400/422', () => {
    const err = new ValidationError('参数校验失败', [
      {
        code: 'MISSING_FIELD',
        path: 'name',
        expected: 'string',
        received: 'undefined',
        message: 'name is required',
      },
    ]);
    const result = buildErrorResponse(err);
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.status).toBeLessThanOrEqual(422);
  });
});
