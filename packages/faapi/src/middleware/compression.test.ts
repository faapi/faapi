import { describe, it, expect } from 'vitest';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { compression, parseAcceptEncoding, selectEncoding } from './compression';
import { createContext } from '../runtime/createContext';
import { compose } from '../runtime/invokeHandler';

const brotliAsync = promisify(zlib.brotliDecompress);
const gzipAsync = promisify(zlib.gunzip);
const deflateAsync = promisify(zlib.inflate);

/** 构造测试 ctx + 经 compose 驱动压缩中间件 */
async function runCompression(
  request: Request,
  handlerResponse: Response | (() => Promise<Response>),
  options?: Parameters<typeof compression>[0],
): Promise<{ res: Response; meta: Record<string, string> }> {
  const ctx = createContext(request, {}, undefined, undefined) as ReturnType<
    typeof createContext
  > & { meta: { headers: Record<string, string>; setCookies: string[] } };
  const mw = compression(options);
  const res = await compose(
    [mw],
    ctx as never,
    typeof handlerResponse === 'function'
      ? handlerResponse
      : () => Promise.resolve(handlerResponse),
  );
  // headers-only meta 走延迟落头通道（发送层 res.setHeader）——单测断言 meta
  return { res, meta: ctx.meta.headers };
}

const bigJson = JSON.stringify({ data: 'x'.repeat(10_000) });

describe('parseAcceptEncoding / selectEncoding', () => {
  it('解析多编码与 q 值（q=0 的编码被过滤）', () => {
    const accepted = parseAcceptEncoding('gzip, br;q=0.8, identity;q=0, *;q=0.5');
    expect(accepted).toEqual([
      { encoding: 'gzip', quality: 1 },
      { encoding: 'br', quality: 0.8 },
      { encoding: '*', quality: 0.5 },
    ]);
  });

  it('服务器偏好 br > gzip > deflate', () => {
    expect(selectEncoding(parseAcceptEncoding('gzip, deflate, br'))).toBe('br');
    expect(selectEncoding(parseAcceptEncoding('gzip, deflate'))).toBe('gzip');
    expect(selectEncoding(parseAcceptEncoding('deflate'))).toBe('deflate');
  });

  it('q=0 明确不接受', () => {
    expect(selectEncoding(parseAcceptEncoding('gzip;q=0'))).toBeNull();
  });

  it('不支持的编码列表返回 null', () => {
    expect(selectEncoding(parseAcceptEncoding('zstd'))).toBeNull();
  });

  it('* 通配按 gzip 处理', () => {
    expect(selectEncoding(parseAcceptEncoding('*'))).toBe('gzip');
  });
});

describe('compression 中间件', () => {
  it('客户端接受 gzip 时压缩 application/json 并设置 Content-Encoding', async () => {
    const request = new Request('http://localhost/api/test', {
      headers: { 'Accept-Encoding': 'gzip' },
    });
    const { res } = await runCompression(
      request,
      new Response(bigJson, { headers: { 'Content-Type': 'application/json' } }),
    );
    expect(res.headers.get('content-encoding')).toBe('gzip');
    const decompressed = await gzipAsync(Buffer.from(await res.arrayBuffer()));
    expect(decompressed.toString('utf-8')).toBe(bigJson);
  });

  it('客户端仅接受 deflate 时使用 deflate', async () => {
    const request = new Request('http://localhost/api/test', {
      headers: { 'Accept-Encoding': 'deflate' },
    });
    const { res } = await runCompression(
      request,
      new Response(bigJson, { headers: { 'Content-Type': 'application/json' } }),
    );
    expect(res.headers.get('content-encoding')).toBe('deflate');
    const decompressed = await deflateAsync(Buffer.from(await res.arrayBuffer()));
    expect(decompressed.toString('utf-8')).toBe(bigJson);
  });

  it('客户端接受 br 时优先 brotli', async () => {
    const request = new Request('http://localhost/api/test', {
      headers: { 'Accept-Encoding': 'gzip, br' },
    });
    const { res } = await runCompression(
      request,
      new Response(bigJson, { headers: { 'Content-Type': 'application/json' } }),
    );
    expect(res.headers.get('content-encoding')).toBe('br');
    const decompressed = await brotliAsync(Buffer.from(await res.arrayBuffer()));
    expect(decompressed.toString('utf-8')).toBe(bigJson);
  });

  it('无 Accept-Encoding 时透传（不压缩）', async () => {
    const request = new Request('http://localhost/api/test');
    const { res, meta } = await runCompression(
      request,
      new Response(bigJson, { headers: { 'Content-Type': 'application/json' } }),
    );
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(await res.text()).toBe(bigJson);
    // Vary 经 meta 传递（发送层落头）
    expect(meta['Vary']).toContain('Accept-Encoding');
  });

  it('低于 threshold 的 body 不压缩', async () => {
    const request = new Request('http://localhost/api/test', {
      headers: { 'Accept-Encoding': 'gzip' },
    });
    const { res } = await runCompression(
      request,
      new Response('{"tiny":true}', { headers: { 'Content-Type': 'application/json' } }),
      { threshold: 1024 },
    );
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(await res.text()).toBe('{"tiny":true}');
  });

  it('text/event-stream 跳过（流式不缓冲）', async () => {
    const request = new Request('http://localhost/api/sse', {
      headers: { 'Accept-Encoding': 'gzip' },
    });
    const { res } = await runCompression(
      request,
      new Response('data: hello\n\n', { headers: { 'Content-Type': 'text/event-stream' } }),
    );
    expect(res.headers.get('content-encoding')).toBeNull();
  });

  it('已有 Content-Encoding 的响应跳过', async () => {
    const request = new Request('http://localhost/api/test', {
      headers: { 'Accept-Encoding': 'gzip' },
    });
    const { res } = await runCompression(
      request,
      new Response(bigJson, {
        headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
      }),
    );
    expect(await res.text()).toBe(bigJson);
  });

  it('Cache-Control: no-transform 跳过', async () => {
    const request = new Request('http://localhost/api/test', {
      headers: { 'Accept-Encoding': 'gzip' },
    });
    const { res } = await runCompression(
      request,
      new Response(bigJson, {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-transform' },
      }),
    );
    expect(res.headers.get('content-encoding')).toBeNull();
  });

  it('304 响应跳过（无 body）', async () => {
    const request = new Request('http://localhost/api/test', {
      headers: { 'Accept-Encoding': 'gzip' },
    });
    const { res } = await runCompression(request, new Response(null, { status: 304 }));
    expect(res.status).toBe(304);
  });

  it('Vary 与 CORS 已设置的 Vary: Origin 合并（不覆盖）', async () => {
    const request = new Request('http://localhost/api/test');
    const ctx = createContext(request, {}, undefined, undefined) as never as {
      meta: { headers: Record<string, string>; setCookies: string[] };
      request: Request;
      setHeader: (k: string, v: string) => void;
    };
    // 模拟内层 CORS 已设置 Vary: Origin
    ctx.setHeader('Vary', 'Origin');

    const mw = compression();
    await compose([mw], ctx as never, async () => Response.json({ ok: true }));
    // Vary 经 meta.headers 传递（发送层落头）
    expect(ctx.meta.headers['Vary']).toContain('Origin');
    expect(ctx.meta.headers['Vary']).toContain('Accept-Encoding');
  });
});
