import { describe, it, expect } from 'vitest';
import { etag } from './etag';
import { createContext } from '../runtime/createContext';
import { compose } from '../runtime/invokeHandler';
import type { FaapiContext, ResponseMeta } from '../runtime/contextTypes';

/** 构造测试 ctx + 经 compose 驱动 etag 中间件 */
async function runEtag(
  request: Request,
  handlerResponse: Response,
  options?: Parameters<typeof etag>[0],
): Promise<{ response: Response; meta: ResponseMeta }> {
  const ctx = createContext(request, {}, undefined, undefined) as unknown as FaapiContext & {
    meta: ResponseMeta;
  };
  const mw = etag(options);
  const response = await compose([mw], ctx as never, () => Promise.resolve(handlerResponse));
  return { response, meta: ctx.meta };
}

describe('etag 中间件', () => {
  it('GET 200 生成弱 ETag 写入 meta', async () => {
    const request = new Request('http://localhost/api/test');
    const { response: bodyResponse, meta } = await runEtag(
      request,
      Response.json({ hello: 'world' }),
    );
    const etagValue = meta.headers['etag'];
    expect(etagValue).toMatch(/^W\/".+"$/);
    // body 保持不变
    expect(await bodyResponse.json()).toEqual({ hello: 'world' });
  });

  it('If-None-Match 命中返回 304（无 body）', async () => {
    const request = new Request('http://localhost/api/test', {
      headers: { 'If-None-Match': 'W/"abc"' },
    });
    // 固定 hash 不可行，改两步：先生成一次拿到 ETag（meta 通道），再模拟命中
    const { meta } = await runEtag(request, Response.json({ hello: 'world' }));
    const etagValue = meta.headers['etag']!;
    expect(etagValue).toBeTruthy();

    // 第二次请求携带上次响应的 ETag
    const request2 = new Request('http://localhost/api/test', {
      headers: { 'If-None-Match': etagValue },
    });
    const { response: res2 } = await runEtag(request2, Response.json({ hello: 'world' }));
    expect(res2.status).toBe(304);
    expect(await res2.text()).toBe('');
    // 304 响应携带 ETag 头（供客户端后续协商）
    expect(res2.headers.get('etag')).toBe(etagValue);
  });

  it('If-None-Match 不匹配返回 200', async () => {
    const request = new Request('http://localhost/api/test', {
      headers: { 'If-None-Match': 'W/"different-value"' },
    });
    const { response } = await runEtag(request, Response.json({ hello: 'world' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ hello: 'world' });
  });

  it('If-None-Match: * 命中任意 ETag', async () => {
    const request = new Request('http://localhost/api/test', {
      headers: { 'If-None-Match': '*' },
    });
    const { response } = await runEtag(request, Response.json({ a: 1 }));
    expect(response.status).toBe(304);
  });

  it('非 GET/HEAD 方法跳过', async () => {
    const request = new Request('http://localhost/api/test', { method: 'POST' });
    const { response, meta } = await runEtag(request, Response.json({ a: 1 }));
    expect(meta.headers['etag']).toBeUndefined();
    expect(response.headers.get('etag')).toBeNull();
  });

  it('handler 已设置 ETag 时不覆盖（handler 控制优先）', async () => {
    const request = new Request('http://localhost/api/test');
    const ctx = createContext(request, {}, undefined, undefined) as unknown as FaapiContext & {
      meta: ResponseMeta;
    };
    ctx.setETag('"custom-etag"');
    const mw = etag();
    await compose([mw], ctx as never, () => Promise.resolve(Response.json({ a: 1 })));
    // meta 中保留 handler 的值（框架不覆盖；headers-only 走延迟落头通道）
    expect(ctx.meta.headers['etag']).toBe('"custom-etag"');
  });

  it('text/event-stream 跳过', async () => {
    const request = new Request('http://localhost/api/sse');
    const { response, meta } = await runEtag(
      request,
      new Response('data: hi\n\n', { headers: { 'Content-Type': 'text/event-stream' } }),
    );
    expect(meta.headers['etag']).toBeUndefined();
    expect(response.headers.get('etag')).toBeNull();
  });

  it('非 2xx 跳过', async () => {
    const request = new Request('http://localhost/api/test');
    const { response, meta } = await runEtag(request, new Response('nope', { status: 500 }));
    expect(meta.headers['etag']).toBeUndefined();
    expect(response.status).toBe(500);
  });

  it('weak: false 生成强 ETag，弱比较不再适用', async () => {
    const request = new Request('http://localhost/api/test');
    const { meta } = await runEtag(request, Response.json({ a: 1 }), { weak: false });
    const etagValue = meta.headers['etag']!;
    // 强 ETag：无 W/ 前缀
    expect(etagValue).toMatch(/^"/);
    expect(etagValue).not.toMatch(/^W\//);

    // 强比较下携带同指纹的弱变体不命中
    const weakVariant = request2WithWeak(etagValue);
    const second = await runEtag(weakVariant, Response.json({ a: 1 }), { weak: false });
    expect(second.response.status).toBe(200);

    // 原样携带强 ETag 命中
    const third = await runEtag(
      new Request('http://localhost/api/test', { headers: { 'If-None-Match': etagValue } }),
      Response.json({ a: 1 }),
      { weak: false },
    );
    expect(third.response.status).toBe(304);
  });
});

/** 构造携带弱变体 If-None-Match 的请求 */
function request2WithWeak(strongEtag: string): Request {
  const inner = strongEtag.slice(1, -1); // 去掉外层引号
  return new Request('http://localhost/api/test', {
    headers: { 'If-None-Match': `W/"${inner}"` },
  });
}
