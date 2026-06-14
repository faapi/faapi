import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'node:http';
import type { Server } from 'node:http';
import type { Socket } from 'node:net';
import type { RequestHandler, UpgradeHandler } from '@faapi/faapi';

// Mock next 模块
const mockNextHandle = vi.fn();
const mockNextUpgradeHandler = vi.fn();

vi.mock('next', () => ({
  default: vi.fn(() => ({
    getRequestHandler: () => mockNextHandle,
    getUpgradeHandler: () => mockNextUpgradeHandler,
    prepare: async () => {},
  })),
}));

import nextPlugin from './createNextServer';
import type { PluginContext } from '@faapi/faapi';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.map(
      (s) =>
        new Promise<void>((resolve) => {
          if (typeof (s as any).closeAllConnections === 'function') {
            (s as any).closeAllConnections();
          }
          s.close(() => resolve());
        }),
    ),
  );
  servers.length = 0;
  vi.clearAllMocks();
});

/** 创建 mock PluginContext，捕获 wrapHandler/wrapUpgradeHandler 调用 */
function createMockContext(options?: unknown): {
  ctx: PluginContext;
  handlerWrappers: Array<(original: RequestHandler) => RequestHandler>;
  upgradeWrappers: Array<(original: UpgradeHandler | undefined) => UpgradeHandler>;
} {
  const handlerWrappers: Array<(original: RequestHandler) => RequestHandler> = [];
  const upgradeWrappers: Array<(original: UpgradeHandler | undefined) => UpgradeHandler> = [];

  const ctx = {
    rootDir: '/tmp/test',
    routes: [],
    server: new http.Server(),
    config: {},
    options,
    wrapHandler: (fn: (original: RequestHandler) => RequestHandler) => {
      handlerWrappers.push(fn);
    },
    wrapUpgradeHandler: (fn: (original: UpgradeHandler | undefined) => UpgradeHandler) => {
      upgradeWrappers.push(fn);
    },
  } as unknown as PluginContext;

  return { ctx, handlerWrappers, upgradeWrappers };
}

/** 用包装器包装原始 handler，返回最终 handler */
function applyWrappers(
  original: RequestHandler,
  wrappers: Array<(original: RequestHandler) => RequestHandler>,
): RequestHandler {
  let handler = original;
  for (const wrap of wrappers) {
    handler = wrap(handler);
  }
  return handler;
}

describe('@faapi/next 插件 - 结构', () => {
  it('导出 FaapiPlugin 接口', () => {
    expect(nextPlugin).toBeDefined();
    expect(nextPlugin.name).toBe('@faapi/next');
    expect(typeof nextPlugin.setup).toBe('function');
  });

  it('setup 调用 ctx.wrapHandler 和 ctx.wrapUpgradeHandler', async () => {
    const { ctx, handlerWrappers, upgradeWrappers } = createMockContext();
    await nextPlugin.setup(ctx);

    expect(handlerWrappers).toHaveLength(1);
    expect(upgradeWrappers).toHaveLength(1);
  });
});

describe('@faapi/next 插件 - HTTP 分流', () => {
  it('/api/* 路径走 faapi handler', async () => {
    const mockFaapiHandler = vi.fn();
    const { ctx, handlerWrappers } = createMockContext();
    await nextPlugin.setup(ctx);

    const finalHandler = applyWrappers(mockFaapiHandler, handlerWrappers);

    // 模拟 faapi handler 响应
    mockFaapiHandler.mockImplementation((req, res) => {
      res.statusCode = 200;
      res.end('faapi');
    });

    const server = http.createServer(finalHandler);
    servers.push(server);
    const port = await new Promise<number>((resolve) => {
      server.listen(0, () => {
        resolve((server.address() as any).port);
      });
    });

    const res = await fetch(`http://localhost:${port}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('faapi');
    expect(mockFaapiHandler).toHaveBeenCalled();
    expect(mockNextHandle).not.toHaveBeenCalled();
  });

  it('/api 精确匹配也走 faapi', async () => {
    const mockFaapiHandler = vi.fn();
    const { ctx, handlerWrappers } = createMockContext();
    await nextPlugin.setup(ctx);

    const finalHandler = applyWrappers(mockFaapiHandler, handlerWrappers);
    mockFaapiHandler.mockImplementation((req, res) => {
      res.statusCode = 200;
      res.end('faapi');
    });

    const server = http.createServer(finalHandler);
    servers.push(server);
    const port = await new Promise<number>((resolve) => {
      server.listen(0, () => resolve((server.address() as any).port));
    });

    const res = await fetch(`http://localhost:${port}/api`);
    expect(res.status).toBe(200);
    expect(mockFaapiHandler).toHaveBeenCalled();
  });

  it('/api2 不匹配 /api 前缀（走 Next.js）', async () => {
    const mockFaapiHandler = vi.fn();
    const { ctx, handlerWrappers } = createMockContext();
    await nextPlugin.setup(ctx);

    const finalHandler = applyWrappers(mockFaapiHandler, handlerWrappers);
    mockNextHandle.mockImplementation((req, res) => {
      res.statusCode = 200;
      res.end('next');
    });

    const server = http.createServer(finalHandler);
    servers.push(server);
    const port = await new Promise<number>((resolve) => {
      server.listen(0, () => resolve((server.address() as any).port));
    });

    const res = await fetch(`http://localhost:${port}/api2`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('next');
    expect(mockNextHandle).toHaveBeenCalled();
    expect(mockFaapiHandler).not.toHaveBeenCalled();
  });

  it('非 /api 路径走 Next.js handler', async () => {
    const mockFaapiHandler = vi.fn();
    const { ctx, handlerWrappers } = createMockContext();
    await nextPlugin.setup(ctx);

    const finalHandler = applyWrappers(mockFaapiHandler, handlerWrappers);
    mockNextHandle.mockImplementation((req, res) => {
      res.statusCode = 200;
      res.end('next');
    });

    const server = http.createServer(finalHandler);
    servers.push(server);
    const port = await new Promise<number>((resolve) => {
      server.listen(0, () => resolve((server.address() as any).port));
    });

    const res = await fetch(`http://localhost:${port}/about`);
    expect(res.status).toBe(200);
    expect(mockNextHandle).toHaveBeenCalled();
  });

  it('根路径 / 走 Next.js', async () => {
    const mockFaapiHandler = vi.fn();
    const { ctx, handlerWrappers } = createMockContext();
    await nextPlugin.setup(ctx);

    const finalHandler = applyWrappers(mockFaapiHandler, handlerWrappers);
    mockNextHandle.mockImplementation((req, res) => {
      res.statusCode = 200;
      res.end('next-home');
    });

    const server = http.createServer(finalHandler);
    servers.push(server);
    const port = await new Promise<number>((resolve) => {
      server.listen(0, () => resolve((server.address() as any).port));
    });

    const res = await fetch(`http://localhost:${port}/`);
    expect(res.status).toBe(200);
    expect(mockNextHandle).toHaveBeenCalled();
  });
});

describe('@faapi/next 插件 - 自定义 apiPrefix', () => {
  it('apiPrefix /v1 时 /v1/* 走 faapi', async () => {
    const mockFaapiHandler = vi.fn();
    const { ctx, handlerWrappers } = createMockContext({ apiPrefix: '/v1' });
    await nextPlugin.setup(ctx);

    const finalHandler = applyWrappers(mockFaapiHandler, handlerWrappers);
    mockFaapiHandler.mockImplementation((req, res) => {
      res.statusCode = 200;
      res.end('faapi');
    });
    mockNextHandle.mockImplementation((req, res) => {
      res.statusCode = 200;
      res.end('next');
    });

    const server = http.createServer(finalHandler);
    servers.push(server);
    const port = await new Promise<number>((resolve) => {
      server.listen(0, () => resolve((server.address() as any).port));
    });

    // /v1/health 走 faapi
    const res1 = await fetch(`http://localhost:${port}/v1/health`);
    expect(await res1.text()).toBe('faapi');

    // /api/health 走 Next.js
    const res2 = await fetch(`http://localhost:${port}/api/health`);
    expect(await res2.text()).toBe('next');
  });
});

describe('@faapi/next 插件 - WebSocket 分流', () => {
  it('/api/* 的 upgrade 走 faapi upgradeHandler', async () => {
    const mockFaapiUpgrade = vi.fn();
    const { ctx, upgradeWrappers } = createMockContext();
    await nextPlugin.setup(ctx);

    const finalUpgrade = upgradeWrappers[0](mockFaapiUpgrade);

    const mockReq = { url: '/api/chat' } as any;
    const mockSocket = { destroy: vi.fn() } as unknown as Socket;
    const mockHead = Buffer.alloc(0);

    finalUpgrade(mockReq, mockSocket, mockHead);

    expect(mockFaapiUpgrade).toHaveBeenCalledWith(mockReq, mockSocket, mockHead);
    expect(mockNextUpgradeHandler).not.toHaveBeenCalled();
  });

  it('非 /api 路径的 upgrade 走 Next.js HMR', async () => {
    const mockFaapiUpgrade = vi.fn();
    const { ctx, upgradeWrappers } = createMockContext();
    await nextPlugin.setup(ctx);

    const finalUpgrade = upgradeWrappers[0](mockFaapiUpgrade);

    const mockReq = { url: '/_next/webpack-hmr' } as any;
    const mockSocket = { destroy: vi.fn() } as unknown as Socket;
    const mockHead = Buffer.alloc(0);

    finalUpgrade(mockReq, mockSocket, mockHead);

    expect(mockNextUpgradeHandler).toHaveBeenCalledWith(mockReq, mockSocket, mockHead);
    expect(mockFaapiUpgrade).not.toHaveBeenCalled();
  });

  it('/api2 不匹配 /api 前缀，upgrade 走 Next.js', async () => {
    const mockFaapiUpgrade = vi.fn();
    const { ctx, upgradeWrappers } = createMockContext();
    await nextPlugin.setup(ctx);

    const finalUpgrade = upgradeWrappers[0](mockFaapiUpgrade);

    const mockReq = { url: '/api2/ws' } as any;
    const mockSocket = { destroy: vi.fn() } as unknown as Socket;
    const mockHead = Buffer.alloc(0);

    finalUpgrade(mockReq, mockSocket, mockHead);

    expect(mockNextUpgradeHandler).toHaveBeenCalled();
    expect(mockFaapiUpgrade).not.toHaveBeenCalled();
  });

  it('faapi 无 WS 路由（original 为 undefined）且非 /api 路径，走 Next.js', async () => {
    const { ctx, upgradeWrappers } = createMockContext();
    await nextPlugin.setup(ctx);

    // original 为 undefined（faapi 无 WS 路由）
    const finalUpgrade = upgradeWrappers[0](undefined);

    const mockReq = { url: '/_next/webpack-hmr' } as any;
    const mockSocket = { destroy: vi.fn() } as unknown as Socket;
    const mockHead = Buffer.alloc(0);

    finalUpgrade(mockReq, mockSocket, mockHead);

    expect(mockNextUpgradeHandler).toHaveBeenCalled();
  });
});

describe('@faapi/next 插件 - dev 模式推断', () => {
  it('NODE_ENV 非 production 时 dev 默认为 true', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    try {
      const { ctx } = createMockContext();
      await nextPlugin.setup(ctx);

      const nextModule = await import('next');
      expect(nextModule.default).toHaveBeenCalledWith(expect.objectContaining({ dev: true }));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('NODE_ENV=production 时 dev 默认为 false', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    try {
      const { ctx } = createMockContext();
      await nextPlugin.setup(ctx);

      const nextModule = await import('next');
      expect(nextModule.default).toHaveBeenCalledWith(expect.objectContaining({ dev: false }));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('options.dev 覆盖 NODE_ENV 推断', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    try {
      const { ctx } = createMockContext({ dev: true });
      await nextPlugin.setup(ctx);

      const nextModule = await import('next');
      expect(nextModule.default).toHaveBeenCalledWith(expect.objectContaining({ dev: true }));
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('@faapi/next 插件 - 默认导出', () => {
  it('默认导出是 FaapiPlugin 对象', async () => {
    const { default: importedPlugin } = await import('./createNextServer');
    expect(importedPlugin).toBe(nextPlugin);
    expect(importedPlugin.name).toBe('@faapi/next');
  });
});
