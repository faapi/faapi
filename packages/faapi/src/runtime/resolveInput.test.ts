import { describe, it, expect } from 'vitest';
import { resolveInput, resolveBodyForQueryMethod } from './resolveInput';
import { ValidationError } from '../errors/httpErrors';

describe('resolveBodyForQueryMethod', () => {
  it('JSON 请求体解析为对象，rawBody 为原始文本', async () => {
    const raw = JSON.stringify({ id: 7 });
    const request = new Request('http://localhost/api/item?id=99', {
      method: 'DELETE',
      body: raw,
      headers: { 'Content-Type': 'application/json' },
    });
    const { input, rawBody } = await resolveBodyForQueryMethod(request);
    expect(input).toEqual({ id: 7 });
    expect(rawBody).toBe(raw);
  });

  it('空请求体返回 null（与 POST 空体同路径，走校验决定 422/透传）', async () => {
    const request = new Request('http://localhost/api/item', { method: 'DELETE' });
    const { input, rawBody } = await resolveBodyForQueryMethod(request);
    expect(input).toBeNull();
    expect(rawBody).toBeUndefined();
  });

  it('纯空白请求体返回 null', async () => {
    const request = new Request('http://localhost/api/item', {
      method: 'DELETE',
      body: '   ',
    });
    const { input } = await resolveBodyForQueryMethod(request);
    expect(input).toBeNull();
  });

  it('form-urlencoded 请求体解析为字符串对象（与 POST 对称）', async () => {
    const request = new Request('http://localhost/api/item', {
      method: 'DELETE',
      body: 'id=7&force=true',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const { input, rawBody } = await resolveBodyForQueryMethod(request);
    expect(input).toEqual({ id: '7', force: 'true' });
    expect(rawBody).toBe('id=7&force=true');
  });

  it('非空非法 JSON 抛 ValidationError(INVALID_FORMAT)', async () => {
    const request = new Request('http://localhost/api/item', {
      method: 'DELETE',
      body: 'not-json',
      headers: { 'Content-Type': 'application/json' },
    });
    await expect(resolveBodyForQueryMethod(request)).rejects.toThrow(ValidationError);
  });
});

describe('resolveInput', () => {
  it('GET 请求返回 query 对象，rawBody 为 undefined', async () => {
    const request = new Request('http://localhost/api/users?name=alice&age=30');
    const { input, rawBody } = await resolveInput('GET', request);
    expect(input).toEqual({ name: 'alice', age: '30' });
    expect(rawBody).toBeUndefined();
  });

  it('DELETE 请求返回 query 对象', async () => {
    const request = new Request('http://localhost/api/users?id=1', { method: 'DELETE' });
    const { input } = await resolveInput('DELETE', request);
    expect(input).toEqual({ id: '1' });
  });

  it('POST 请求返回 body 对象，rawBody 为原始 JSON 文本', async () => {
    const raw = JSON.stringify({ name: 'alice', age: 30 });
    const request = new Request('http://localhost/api/users', {
      method: 'POST',
      body: raw,
      headers: { 'Content-Type': 'application/json' },
    });
    const { input, rawBody } = await resolveInput('POST', request);
    expect(input).toEqual({ name: 'alice', age: 30 });
    expect(rawBody).toBe(raw);
  });

  it('PUT 请求返回 body 对象', async () => {
    const request = new Request('http://localhost/api/users/1', {
      method: 'PUT',
      body: JSON.stringify({ name: 'bob' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const { input } = await resolveInput('PUT', request);
    expect(input).toEqual({ name: 'bob' });
  });

  it('非法 JSON body 抛 ValidationError(INVALID_FORMAT)', async () => {
    const makeRequest = () =>
      new Request('http://localhost/api/users', {
        method: 'POST',
        body: 'not json',
        headers: { 'Content-Type': 'application/json' },
      });
    await expect(resolveInput('POST', makeRequest())).rejects.toBeInstanceOf(ValidationError);
    await expect(resolveInput('POST', makeRequest())).rejects.toMatchObject({
      name: 'ValidationError',
      code: 'VALIDATION_ERROR',
      statusCode: 400,
      issues: [
        {
          path: 'body',
          code: 'INVALID_FORMAT',
          expected: 'JSON',
          received: 'text',
        },
      ],
    });
  });

  it('不完整的 JSON body 抛 ValidationError(INVALID_FORMAT)', async () => {
    const request = new Request('http://localhost/api/users', {
      method: 'POST',
      body: '{"broken":',
      headers: { 'Content-Type': 'application/json' },
    });
    await expect(resolveInput('POST', request)).rejects.toBeInstanceOf(ValidationError);
  });

  it('纯空白 body 返回 null（视为无 body）', async () => {
    const request = new Request('http://localhost/api/users', {
      method: 'POST',
      body: '   \n\t  ',
      headers: { 'Content-Type': 'application/json' },
    });
    const { input } = await resolveInput('POST', request);
    expect(input).toBeNull();
  });

  it('multipart/form-data 请求返回 fields 和 files，rawBody 为 undefined', async () => {
    const formData = new FormData();
    formData.append('name', 'test');
    formData.append('file', new File(['content'], 'test.txt', { type: 'text/plain' }));
    const request = new Request('http://localhost/test', {
      method: 'POST',
      body: formData,
    });
    const { input, rawBody } = await resolveInput('POST', request);
    const result = input as {
      fields: Record<string, string>;
      files: Array<{ name: string; filename: string; type: string; size: number }>;
    };
    expect(result).toHaveProperty('fields');
    expect(result).toHaveProperty('files');
    expect(result.fields.name).toBe('test');
    expect(result.files).toHaveLength(1);
    expect(result.files[0].name).toBe('file');
    expect(result.files[0].filename).toBe('test.txt');
    expect(result.files[0].type).toBe('text/plain');
    expect(result.files[0].size).toBe(7);
    // multipart 是二进制流，无原始文本形态
    expect(rawBody).toBeUndefined();
  });

  it('application/x-www-form-urlencoded 请求返回表单字段对象，rawBody 为原始文本', async () => {
    const request = new Request('http://localhost/api/users', {
      method: 'POST',
      body: 'name=alice&age=30',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const { input, rawBody } = await resolveInput('POST', request);
    expect(input).toEqual({ name: 'alice', age: '30' });
    expect(rawBody).toBe('name=alice&age=30');
  });

  it('application/x-www-form-urlencoded 空 body 返回 null', async () => {
    const request = new Request('http://localhost/api/users', {
      method: 'POST',
      body: '',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const { input } = await resolveInput('POST', request);
    expect(input).toBeNull();
  });

  it('POST 空 body 返回 null', async () => {
    const request = new Request('http://localhost/api/users', {
      method: 'POST',
      body: '',
      headers: { 'Content-Type': 'application/json' },
    });
    const { input } = await resolveInput('POST', request);
    expect(input).toBeNull();
  });

  it('PATCH 请求返回 body 对象', async () => {
    const request = new Request('http://localhost/api/users/1', {
      method: 'PATCH',
      body: JSON.stringify({ name: 'patched' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const { input } = await resolveInput('PATCH', request);
    expect(input).toEqual({ name: 'patched' });
  });

  it('DELETE 带 query 参数返回 query 对象', async () => {
    const request = new Request('http://localhost/api/users?status=active&page=2', {
      method: 'DELETE',
    });
    const { input } = await resolveInput('DELETE', request);
    expect(input).toEqual({ status: 'active', page: '2' });
  });

  it('HEAD 请求返回 query 对象', async () => {
    const request = new Request('http://localhost/api/users', { method: 'HEAD' });
    const { input } = await resolveInput('HEAD', request);
    expect(input).toEqual({});
  });
});
