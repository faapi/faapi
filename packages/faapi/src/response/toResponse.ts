import { isPlainObject } from '../utils/isPlainObject';
import type { ResponseMeta } from '../runtime/contextTypes';

/**
 * 将 handler 返回值统一转换为 Response
 *
 * 规则：
 * - Response 对象：原样返回
 * - ReadableStream：直接作为 body
 * - Buffer / Uint8Array：作为二进制 body
 * - 普通对象/数组：JSON.stringify，Content-Type: application/json
 * - string：text/plain
 * - number/boolean：text/plain，String(value)
 * - null/undefined：204 No Content
 * - Promise：await 后再处理
 *
 * 如果传入了 meta，会将 ctx.setStatus / ctx.setHeader 的设置合并到 Response 中
 */
export async function toResponse(value: unknown, meta?: ResponseMeta): Promise<Response> {
  // Promise：await 后再处理
  if (value instanceof Promise) {
    return toResponse(await value, meta);
  }

  // 辅助函数：将 meta headers 和 setCookies 合并到 Headers 对象
  const applyMeta = (headers: Headers): void => {
    if (!meta) return;
    for (const [key, val] of Object.entries(meta.headers)) {
      headers.set(key, val);
    }
    for (const cookie of meta.setCookies ?? []) {
      headers.append('set-cookie', cookie);
    }
  };

  // Response 对象：原样返回（但合并 meta headers）
  if (value instanceof Response) {
    if (
      meta &&
      (meta.status !== undefined ||
        Object.keys(meta.headers).length > 0 ||
        meta.setCookies.length > 0)
    ) {
      const headers = new Headers(value.headers);
      applyMeta(headers);
      return new Response(value.body, {
        status: meta.status ?? value.status,
        headers,
      });
    }
    return value;
  }

  // null/undefined：204 No Content
  if (value === null || value === undefined) {
    const status = meta?.status ?? 204;
    const headers = new Headers();
    applyMeta(headers);
    return new Response(null, { status, headers });
  }

  // ReadableStream：直接作为 body
  if (typeof ReadableStream !== 'undefined' && value instanceof ReadableStream) {
    const headers = new Headers({ 'Content-Type': 'application/octet-stream' });
    applyMeta(headers);
    return new Response(value, {
      status: meta?.status ?? 200,
      headers,
    });
  }

  // Buffer / Uint8Array：作为二进制 body
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) {
    const headers = new Headers({ 'Content-Type': 'application/octet-stream' });
    applyMeta(headers);
    return new Response(value as BodyInit, {
      status: meta?.status ?? 200,
      headers,
    });
  }
  if (value instanceof Uint8Array) {
    const headers = new Headers({ 'Content-Type': 'application/octet-stream' });
    applyMeta(headers);
    return new Response(value as BodyInit, {
      status: meta?.status ?? 200,
      headers,
    });
  }

  // 普通对象/数组：JSON.stringify，Content-Type: application/json
  if (isPlainObject(value) || Array.isArray(value)) {
    const body = JSON.stringify(value);
    const headers = new Headers({ 'Content-Type': 'application/json' });
    applyMeta(headers);
    return new Response(body, {
      status: meta?.status ?? 200,
      headers,
    });
  }

  // string：text/plain
  if (typeof value === 'string') {
    const headers = new Headers({ 'Content-Type': 'text/plain' });
    applyMeta(headers);
    return new Response(value, {
      status: meta?.status ?? 200,
      headers,
    });
  }

  // number/boolean：text/plain，String(value)
  if (typeof value === 'number' || typeof value === 'boolean') {
    const headers = new Headers({ 'Content-Type': 'text/plain' });
    applyMeta(headers);
    return new Response(String(value), {
      status: meta?.status ?? 200,
      headers,
    });
  }

  // 其他类型 fallback：JSON.stringify
  const body = JSON.stringify(value);
  const headers = new Headers({ 'Content-Type': 'application/json' });
  applyMeta(headers);
  return new Response(body, {
    status: meta?.status ?? 200,
    headers,
  });
}
