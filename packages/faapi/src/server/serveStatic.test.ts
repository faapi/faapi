import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { serveStatic } from './serveStatic';

const TMP_DIR = path.join(import.meta.dirname, '__serveStatic_test_tmp__');

beforeAll(async () => {
  await fs.mkdir(TMP_DIR, { recursive: true });
  await fs.writeFile(path.join(TMP_DIR, 'hello.txt'), 'hello world');
  await fs.writeFile(path.join(TMP_DIR, 'style.css'), 'body { color: red; }');
  await fs.writeFile(path.join(TMP_DIR, 'app.js'), 'console.log("hi")');
  await fs.writeFile(path.join(TMP_DIR, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await fs.mkdir(path.join(TMP_DIR, 'sub'), { recursive: true });
  await fs.writeFile(path.join(TMP_DIR, 'sub', 'data.json'), '{"key":"value"}');
  await fs.mkdir(path.join(TMP_DIR, 'dir-with-index'), { recursive: true });
  await fs.writeFile(path.join(TMP_DIR, 'dir-with-index', 'index.html'), '<h1>Index</h1>');
});

afterAll(async () => {
  await fs.rm(TMP_DIR, { recursive: true, force: true });
});

describe('serveStatic', () => {
  it('提供已存在的文件并返回正确的 Content-Type', async () => {
    const res = await serveStatic('/hello.txt', TMP_DIR);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(res!.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
    const body = await res!.text();
    expect(body).toBe('hello world');
  });

  it('CSS 文件返回 text/css', async () => {
    const res = await serveStatic('/style.css', TMP_DIR);
    expect(res).not.toBeNull();
    expect(res!.headers.get('Content-Type')).toBe('text/css; charset=utf-8');
  });

  it('JS 文件返回 application/javascript', async () => {
    const res = await serveStatic('/app.js', TMP_DIR);
    expect(res).not.toBeNull();
    expect(res!.headers.get('Content-Type')).toBe('application/javascript; charset=utf-8');
  });

  it('PNG 文件返回 image/png', async () => {
    const res = await serveStatic('/image.png', TMP_DIR);
    expect(res).not.toBeNull();
    expect(res!.headers.get('Content-Type')).toBe('image/png');
  });

  it('子目录中的文件可正常访问', async () => {
    const res = await serveStatic('/sub/data.json', TMP_DIR);
    expect(res).not.toBeNull();
    expect(res!.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    const body = await res!.text();
    expect(body).toBe('{"key":"value"}');
  });

  it('目录路径自动查找 index.html', async () => {
    const res = await serveStatic('/dir-with-index', TMP_DIR);
    expect(res).not.toBeNull();
    expect(res!.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    const body = await res!.text();
    expect(body).toBe('<h1>Index</h1>');
  });

  it('目录路径带尾部斜杠也可查找 index.html', async () => {
    const res = await serveStatic('/dir-with-index/', TMP_DIR);
    expect(res).not.toBeNull();
    expect(res!.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
  });

  it('不存在的文件返回 null', async () => {
    const res = await serveStatic('/nonexistent.txt', TMP_DIR);
    expect(res).toBeNull();
  });

  it('无 index.html 的目录返回 null', async () => {
    const res = await serveStatic('/sub', TMP_DIR);
    expect(res).toBeNull();
  });

  it('防止路径遍历攻击', async () => {
    const res = await serveStatic('/../../../etc/passwd', TMP_DIR);
    expect(res).toBeNull();
  });

  it('防止路径遍历攻击（..中间段）', async () => {
    const res = await serveStatic('/foo/../../etc/passwd', TMP_DIR);
    expect(res).toBeNull();
  });

  it('未知扩展名返回 application/octet-stream', async () => {
    const weirdFile = path.join(TMP_DIR, 'data.xyz');
    await fs.writeFile(weirdFile, 'weird');
    const res = await serveStatic('/data.xyz', TMP_DIR);
    expect(res).not.toBeNull();
    expect(res!.headers.get('Content-Type')).toBe('application/octet-stream');
    await fs.rm(weirdFile);
  });

  it('响应包含 Cache-Control 头', async () => {
    const res = await serveStatic('/hello.txt', TMP_DIR);
    expect(res).not.toBeNull();
    expect(res!.headers.get('Cache-Control')).toBe('public, max-age=3600');
  });
});
