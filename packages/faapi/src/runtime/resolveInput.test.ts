import { describe, it, expect } from 'vitest';
import { resolveInput } from './resolveInput';
import { ValidationError } from '../errors/httpErrors';

describe('resolveInput', () => {
  it('GET 请求返回 query 对象', async () => {
    const request = new Request('http://localhost/api/users?name=alice&age=30');
    const result = await resolveInput('GET', request);
    expect(result).toEqual({ name: 'alice', age: '30' });
  });

  it('DELETE 请求返回 query 对象', async () => {
    const request = new Request('http://localhost/api/users?id=1', { method: 'DELETE' });
    const result = await resolveInput('DELETE', request);
    expect(result).toEqual({ id: '1' });
  });

  it('POST 请求返回 body 对象', async () => {
    const request = new Request('http://localhost/api/users', {
      method: 'POST',
      body: JSON.stringify({ name: 'alice', age: 30 }),
      headers: { 'Content-Type': 'application/json' },
    });
    const result = await resolveInput('POST', request);
    expect(result).toEqual({ name: 'alice', age: 30 });
  });

  it('PUT 请求返回 body 对象', async () => {
    const request = new Request('http://localhost/api/users/1', {
      method: 'PUT',
      body: JSON.stringify({ name: 'bob' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const result = await resolveInput('PUT', request);
    expect(result).toEqual({ name: 'bob' });
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
    const result = await resolveInput('POST', request);
    expect(result).toBeNull();
  });

  it('multipart/form-data 请求返回 fields 和 files', async () => {
    const formData = new FormData();
    formData.append('name', 'test');
    formData.append('file', new File(['content'], 'test.txt', { type: 'text/plain' }));
    const request = new Request('http://localhost/test', {
      method: 'POST',
      body: formData,
    });
    const result = (await resolveInput('POST', request)) as {
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
  });

  it('application/x-www-form-urlencoded 请求返回表单字段对象', async () => {
    const request = new Request('http://localhost/api/users', {
      method: 'POST',
      body: 'name=alice&age=30',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const result = await resolveInput('POST', request);
    expect(result).toEqual({ name: 'alice', age: '30' });
  });

  it('application/x-www-form-urlencoded 空 body 返回 null', async () => {
    const request = new Request('http://localhost/api/users', {
      method: 'POST',
      body: '',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const result = await resolveInput('POST', request);
    expect(result).toBeNull();
  });

  it('POST 空 body 返回 null', async () => {
    const request = new Request('http://localhost/api/users', {
      method: 'POST',
      body: '',
      headers: { 'Content-Type': 'application/json' },
    });
    const result = await resolveInput('POST', request);
    expect(result).toBeNull();
  });

  it('PATCH 请求返回 body 对象', async () => {
    const request = new Request('http://localhost/api/users/1', {
      method: 'PATCH',
      body: JSON.stringify({ name: 'patched' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const result = await resolveInput('PATCH', request);
    expect(result).toEqual({ name: 'patched' });
  });

  it('DELETE 带 query 参数返回 query 对象', async () => {
    const request = new Request('http://localhost/api/users?status=active&page=2', {
      method: 'DELETE',
    });
    const result = await resolveInput('DELETE', request);
    expect(result).toEqual({ status: 'active', page: '2' });
  });

  it('HEAD 请求返回 query 对象', async () => {
    const request = new Request('http://localhost/api/users', { method: 'HEAD' });
    const result = await resolveInput('HEAD', request);
    expect(result).toEqual({});
  });
});
