import { describe, it, expect } from 'vitest';
import { toResponse } from './toResponse';

describe('toResponse', () => {
  it('返回普通对象 -> JSON response, Content-Type: application/json', async () => {
    const res = await toResponse({ name: 'faapi' });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    const body = await res.json();
    expect(body).toEqual({ name: 'faapi' });
  });

  it('返回数组 -> JSON response', async () => {
    const res = await toResponse([1, 2, 3]);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    const body = await res.json();
    expect(body).toEqual([1, 2, 3]);
  });

  it('返回字符串 -> text/plain', async () => {
    const res = await toResponse('hello');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/plain');
    const body = await res.text();
    expect(body).toBe('hello');
  });

  it('返回数字 -> text/plain', async () => {
    const res = await toResponse(42);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/plain');
    const body = await res.text();
    expect(body).toBe('42');
  });

  it('返回布尔值 -> text/plain', async () => {
    const res = await toResponse(true);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/plain');
    const body = await res.text();
    expect(body).toBe('true');
  });

  it('返回 null -> 204 No Content', async () => {
    const res = await toResponse(null);
    expect(res.status).toBe(204);
    const body = await res.text();
    expect(body).toBe('');
  });

  it('返回 undefined -> 204 No Content', async () => {
    const res = await toResponse(undefined);
    expect(res.status).toBe(204);
    const body = await res.text();
    expect(body).toBe('');
  });

  it('返回 Response -> 原样透传', async () => {
    const original = new Response('raw', {
      status: 201,
      headers: { 'X-Custom': 'test' },
    });
    const res = await toResponse(original);
    expect(res).toBe(original);
    expect(res.status).toBe(201);
    expect(res.headers.get('X-Custom')).toBe('test');
    const body = await res.text();
    expect(body).toBe('raw');
  });

  it('返回 Promise<object> -> 等待后转 JSON', async () => {
    const res = await toResponse(Promise.resolve({ async: true }));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    const body = await res.json();
    expect(body).toEqual({ async: true });
  });

  // meta 相关测试
  it('meta.status 覆盖默认状态码', async () => {
    const res = await toResponse({ created: true }, { status: 201, headers: {}, setCookies: [] });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toEqual({ created: true });
  });

  it('meta.headers 合并到响应头', async () => {
    const res = await toResponse(
      { data: [] },
      { headers: { 'Cache-Control': 'max-age=3600' }, setCookies: [] },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('max-age=3600');
    expect(res.headers.get('Content-Type')).toBe('application/json');
  });

  it('meta.status 和 meta.headers 同时生效', async () => {
    const res = await toResponse(null, {
      status: 204,
      headers: { 'X-Custom': 'yes' },
      setCookies: [],
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('X-Custom')).toBe('yes');
  });

  it('meta.headers 可覆盖 Content-Type', async () => {
    const res = await toResponse(
      { data: 1 },
      { headers: { 'Content-Type': 'text/html' }, setCookies: [] },
    );
    expect(res.headers.get('Content-Type')).toBe('text/html');
  });

  it('返回 Response 时 meta 合并 headers 和 status', async () => {
    const original = new Response('raw', { status: 200, headers: { 'X-Original': 'yes' } });
    const res = await toResponse(original, {
      status: 201,
      headers: { 'X-Meta': 'added' },
      setCookies: [],
    });
    expect(res.status).toBe(201);
    expect(res.headers.get('X-Original')).toBe('yes');
    expect(res.headers.get('X-Meta')).toBe('added');
  });

  it('meta.setCookies 正确添加 Set-Cookie 响应头', async () => {
    const res = await toResponse(
      { ok: true },
      {
        headers: {},
        setCookies: ['token=abc; Path=/; HttpOnly', 'lang=zh; Path=/'],
      },
    );
    expect(res.headers.get('Set-Cookie')).toBe('token=abc; Path=/; HttpOnly, lang=zh; Path=/');
  });

  it('meta.setCookies 与 meta.headers 同时生效', async () => {
    const res = await toResponse(null, {
      status: 204,
      headers: { 'X-Custom': 'yes' },
      setCookies: ['session=xyz'],
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('X-Custom')).toBe('yes');
    expect(res.headers.get('Set-Cookie')).toBe('session=xyz');
  });
});
