import { describe, it, expect, afterAll, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import http from 'node:http';
import { scanRoutes } from '../router/scanRoutes';
import { sortRoutes } from '../router/sortRoutes';
import { createServer } from './createServer';
import { generateSchemaFiles } from '../cli/generateSchemaFiles';
import type { Server } from 'node:http';

/**
 * 客户端断连信号 E2E——ctx.request.signal 接线 socket close
 *
 * handler 与测试文件跨模块共享状态用 globalThis 桥接（同进程 import）。
 * 客户端断连用 node:http 真实 socket 发起后 destroy 模拟。
 */

interface AbortProbe {
  /** abort 信号是否触发（wait-abort handler 等到 abort 后置 true） */
  signalFired: boolean;
  /** handler 返回前记录的 signal.aborted（正常完成应 为 false） */
  abortedAtReturn: boolean;
  /** ctx.request.signal 是否为 AbortSignal 实例 */
  hasSignal: boolean;
}

function getProbe(key: string): AbortProbe | undefined {
  return (globalThis as Record<string, unknown>)[key] as AbortProbe | undefined;
}

const HANDLER_WAIT_ABORT = `
export async function GET(ctx) {
  await new Promise((resolve) => {
    if (ctx.request.signal.aborted) {
      resolve();
      return;
    }
    ctx.request.signal.addEventListener('abort', () => resolve(), { once: true });
  });
  globalThis.__faapiAbortWaitProbe = { signalFired: true, abortedAtReturn: null, hasSignal: true };
  return new Response('aborted-marker');
}
`;

const HANDLER_NORMAL = `
export async function GET(ctx) {
  await new Promise((resolve) => setTimeout(resolve, 50));
  globalThis.__faapiAbortNormalProbe = {
    signalFired: false,
    abortedAtReturn: ctx.request.signal.aborted,
    hasSignal: ctx.request.signal instanceof AbortSignal,
  };
  return new Response('normal-ok');
}
`;

const HANDLER_POST = `
export async function POST(ctx) {
  globalThis.__faapiAbortPostProbe = {
    signalFired: false,
    abortedAtReturn: ctx.request.signal.aborted,
    hasSignal: ctx.request.signal instanceof AbortSignal,
  };
  return new Response('post-ok');
}
`;

let server: Server | null = null;
let baseUrl: string;
const tmpDirs: string[] = [];

async function setupServer(): Promise<{ server: Server; baseUrl: string }> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'faapi-abort-e2e-'));
  tmpDirs.push(rootDir);
  await fs.mkdir(path.join(rootDir, 'api/wait-abort'), { recursive: true });
  await fs.mkdir(path.join(rootDir, 'api/normal'), { recursive: true });
  await fs.mkdir(path.join(rootDir, 'api/post-echo'), { recursive: true });
  await fs.writeFile(path.join(rootDir, 'api/wait-abort/handler.ts'), HANDLER_WAIT_ABORT);
  await fs.writeFile(path.join(rootDir, 'api/normal/handler.ts'), HANDLER_NORMAL);
  await fs.writeFile(path.join(rootDir, 'api/post-echo/handler.ts'), HANDLER_POST);

  const { routes } = await scanRoutes(rootDir, ['api/**/*.ts']);
  const sorted = sortRoutes(routes);
  const dist = await fs.mkdtemp(path.join(os.tmpdir(), 'faapi-abort-schema-'));
  tmpDirs.push(dist);
  await generateSchemaFiles(sorted, rootDir, dist);
  const { server: srv } = createServer({ routes: sorted, rootDir, dist });

  return new Promise((resolve, reject) => {
    srv.listen(0, () => {
      const addr = srv.address();
      if (typeof addr === 'object' && addr !== null) {
        resolve({ server: srv, baseUrl: `http://localhost:${addr.port}` });
      } else {
        reject(new Error('Failed to get server address'));
      }
    });
  });
}

async function getServer(): Promise<{ server: Server; baseUrl: string }> {
  if (!server) {
    const result = await setupServer();
    server = result.server;
    baseUrl = result.baseUrl;
  }
  return { server, baseUrl };
}

afterAll(async () => {
  await new Promise<void>((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
  });
  await Promise.all(tmpDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('客户端断连信号（ctx.request.signal）E2E', () => {
  it('handler 阻塞等待期间客户端断开 → signal 触发', async () => {
    const { baseUrl: url } = await getServer();

    // 真实 socket 发起请求（handler 阻塞等 abort），稍后 destroy 模拟客户端断连
    const clientReq = http.get(`${url}/api/wait-abort`);
    clientReq.on('error', () => {}); // destroy 后客户端侧 ECONNRESET,忽略
    setTimeout(() => clientReq.destroy(), 150);

    await vi.waitFor(
      () => {
        expect(getProbe('__faapiAbortWaitProbe')?.signalFired).toBe(true);
      },
      { timeout: 5000, interval: 50 },
    );
  });

  it('正常完成不触发断连信号,响应完整到达客户端', async () => {
    const { baseUrl: url } = await getServer();

    const res = await fetch(`${url}/api/normal`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('normal-ok');

    await vi.waitFor(
      () => {
        expect(getProbe('__faapiAbortNormalProbe')).toBeDefined();
      },
      { timeout: 5000, interval: 50 },
    );
    const probe = getProbe('__faapiAbortNormalProbe')!;
    expect(probe.abortedAtReturn).toBe(false);
    expect(probe.hasSignal).toBe(true);
  });

  it('POST（携带请求体分支）的 request.signal 同样接线', async () => {
    const { baseUrl: url } = await getServer();

    const res = await fetch(`${url}/api/post-echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('post-ok');

    await vi.waitFor(
      () => {
        expect(getProbe('__faapiAbortPostProbe')).toBeDefined();
      },
      { timeout: 5000, interval: 50 },
    );
    expect(getProbe('__faapiAbortPostProbe')!.hasSignal).toBe(true);
  });
});
