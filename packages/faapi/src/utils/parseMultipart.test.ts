import { describe, it, expect } from 'vitest';
import { parseMultipart } from './parseMultipart';

describe('parseMultipart', () => {
  it('解析包含字段和文件的 multipart 请求', async () => {
    const formData = new FormData();
    formData.append('name', 'alice');
    formData.append('age', '30');
    formData.append('avatar', new File(['hello world'], 'photo.png', { type: 'image/png' }));

    const request = new Request('http://localhost/upload', {
      method: 'POST',
      body: formData,
    });

    const result = await parseMultipart(request);

    expect(result.fields).toEqual({ name: 'alice', age: '30' });
    expect(result.files).toHaveLength(1);
    expect(result.files[0].name).toBe('avatar');
    expect(result.files[0].filename).toBe('photo.png');
    expect(result.files[0].type).toBe('image/png');
    expect(result.files[0].size).toBe(11);

    const buffer = await result.files[0].arrayBuffer();
    expect(new TextDecoder().decode(buffer)).toBe('hello world');
  });

  it('解析空的 multipart 请求', async () => {
    const formData = new FormData();
    const request = new Request('http://localhost/upload', {
      method: 'POST',
      body: formData,
    });

    const result = await parseMultipart(request);

    expect(result.fields).toEqual({});
    expect(result.files).toEqual([]);
  });

  it('解析只有字段没有文件的 multipart 请求', async () => {
    const formData = new FormData();
    formData.append('username', 'bob');
    formData.append('email', 'bob@example.com');

    const request = new Request('http://localhost/upload', {
      method: 'POST',
      body: formData,
    });

    const result = await parseMultipart(request);

    expect(result.fields).toEqual({ username: 'bob', email: 'bob@example.com' });
    expect(result.files).toEqual([]);
  });

  it('解析多个文件的 multipart 请求', async () => {
    const formData = new FormData();
    formData.append('title', 'my documents');
    formData.append('file1', new File(['content1'], 'doc1.txt', { type: 'text/plain' }));
    formData.append('file2', new File(['content2'], 'doc2.txt', { type: 'text/plain' }));

    const request = new Request('http://localhost/upload', {
      method: 'POST',
      body: formData,
    });

    const result = await parseMultipart(request);

    expect(result.fields).toEqual({ title: 'my documents' });
    expect(result.files).toHaveLength(2);
    expect(result.files[0].name).toBe('file1');
    expect(result.files[0].filename).toBe('doc1.txt');
    expect(result.files[1].name).toBe('file2');
    expect(result.files[1].filename).toBe('doc2.txt');
  });

  it('文件无 MIME 类型时 type 为空字符串', async () => {
    const formData = new FormData();
    formData.append('file', new File(['data'], 'file.bin'));

    const request = new Request('http://localhost/upload', {
      method: 'POST',
      body: formData,
    });

    const result = await parseMultipart(request);

    expect(result.files).toHaveLength(1);
    expect(result.files[0].type).toBe('application/octet-stream');
    expect(result.files[0].filename).toBe('file.bin');
  });
});
