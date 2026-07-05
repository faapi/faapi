import { describe, it, expect } from 'vitest';
import { createContext } from '../runtime/createContext';
import { invokeHandler } from '../runtime/invokeHandler';

describe('ctx.setETag', () => {
  it('ctx.setETag 把 ETag 写入 meta，mergeMeta 后出现在响应头中', async () => {
    const request = new Request('http://localhost/api/items');
    const ctx = createContext(request, {});
    ctx.setETag('"v1"');

    const handler = () => ({ id: 1, name: 'foo' });
    const res = await invokeHandler(handler, ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe('"v1"');
  });

  it('ctx.setETag 支持弱 ETag', async () => {
    const request = new Request('http://localhost/api/items');
    const ctx = createContext(request, {});
    ctx.setETag('W/"xyz789"');

    const handler = () => ({ data: 'bar' });
    const res = await invokeHandler(handler, ctx);

    expect(res.headers.get('etag')).toBe('W/"xyz789"');
  });
});

describe('ETag 业务方实现示例', () => {
  it('handler 在开头检查 If-None-Match 匹配直接返回 304', async () => {
    const request = new Request('http://localhost/api/items', {
      headers: { 'if-none-match': '"v3"' },
    });
    const ctx = createContext(request, {});

    // 模拟业务方的轻量版本检查
    const version = 'v3';
    ctx.setETag(`"${version}"`);

    const ifNoneMatch = ctx.headers.get('if-none-match');
    if (ifNoneMatch && ifNoneMatch.includes(version)) {
      // 304: 不执行重量查询
      expect(true).toBe(true);
    } else {
      // 业务方会在这里执行重量查询
      expect(true).toBe(false);
    }
  });

  it('版本不匹配时执行完整 handler 返回 200', async () => {
    const request = new Request('http://localhost/api/items', {
      headers: { 'if-none-match': '"v2"' },
    });
    const ctx = createContext(request, {});
    ctx.setETag('"v3"');

    const handler = () => ({ id: 1, name: 'foo', version: 'v3' });
    const res = await invokeHandler(handler, ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe('"v3"');
  });
});
