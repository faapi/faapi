import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'node:http';
import path from 'node:path';
import type { Server } from 'node:http';
import type { Socket } from 'node:net';
import type { RequestHandler, UpgradeHandler } from '@faapi/faapi';

// Mock next 模块
const mockNextHandle = vi.fn();
const mockNextUpgradeHandler = vi.fn();
const mockNextFactory = vi.fn(() => ({
  getRequestHandler: () => mockNextHandle,
  getUpgradeHandler: () => mockNextUpgradeHandler,
  prepare: async () => {},
}));

vi.mock('next', () => ({
  default: mockNextFactory,
}));

// Mock next/constants（phase 常量，loadConfig 用）
vi.mock('next/constants', () => ({
  PHASE_DEVELOPMENT_SERVER: 'phase-development-server',
  PHASE_PRODUCTION_SERVER: 'phase-production-server',
}));

// Mock next/dist/server/config（loadConfig）
const mockLoadConfig = vi.fn();
vi.mock('next/dist/server/config', () => ({
  default: mockLoadConfig,
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
  // mockLoadConfig 默认返回 undefined（模拟 loadConfig 失败/无 next.config.ts）
  mockLoadConfig.mockResolvedValue(undefined);
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
    getRoutes: () => [],
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

describe('@faapi/next 插件 - trustHostHeader 自动开启', () => {
  it('默认（不传 trustHostHeader）开启 trustHostHeader，加载用户配置并合并', async () => {
    // 模拟用户 next.config.ts 已有配置（含 experimental 和其他字段）
    mockLoadConfig.mockResolvedValue({
      images: { remotePatterns: [{ protocol: 'https', hostname: '**' }] },
      experimental: { trustHostHeader: false, anotherExp: true },
    });
    const { ctx } = createMockContext();
    await nextPlugin.setup(ctx);

    expect(mockLoadConfig).toHaveBeenCalledWith('phase-development-server', '/tmp/test', {
      silent: true,
    });
    // next() 被调用时 conf 包含 experimental.trustHostHeader=true
    expect(mockNextFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        conf: expect.objectContaining({
          experimental: expect.objectContaining({ trustHostHeader: true }),
        }),
      }),
    );
    // 用户的其他配置被保留
    const calls = mockNextFactory.mock.calls as unknown as Array<
      [{ conf: Record<string, unknown> }]
    >;
    const callArg = calls[0][0];
    expect(callArg.conf.images).toEqual({
      remotePatterns: [{ protocol: 'https', hostname: '**' }],
    });
    expect(callArg.conf.experimental).toHaveProperty('anotherExp', true);
  });

  it('用户已在 next.config.ts 显式开启 trustHostHeader=true 时不重复设置', async () => {
    mockLoadConfig.mockResolvedValue({
      experimental: { trustHostHeader: true, taint: true },
    });
    const { ctx } = createMockContext();
    await nextPlugin.setup(ctx);

    expect(mockNextFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        conf: expect.objectContaining({
          experimental: expect.objectContaining({ trustHostHeader: true, taint: true }),
        }),
      }),
    );
  });

  it('trustHostHeader: false 时不加载 next.config.ts，不传 conf', async () => {
    const { ctx } = createMockContext({ trustHostHeader: false });
    await nextPlugin.setup(ctx);

    expect(mockLoadConfig).not.toHaveBeenCalled();
    expect(mockNextFactory).toHaveBeenCalledWith(
      expect.not.objectContaining({ conf: expect.anything() }),
    );
  });

  it('loadConfig 失败时退回不传 conf，打印警告', async () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockLoadConfig.mockRejectedValue(new Error('config not found'));

    const { ctx } = createMockContext();
    await nextPlugin.setup(ctx);

    expect(mockNextFactory).toHaveBeenCalledWith(
      expect.not.objectContaining({ conf: expect.anything() }),
    );
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('experimental.trustHostHeader'),
    );
    consoleWarnSpy.mockRestore();
  });

  it('prod 模式用 PHASE_PRODUCTION_SERVER 加载配置', async () => {
    mockLoadConfig.mockResolvedValue({ experimental: {} });
    const { ctx } = createMockContext({ dev: false });
    await nextPlugin.setup(ctx);

    expect(mockLoadConfig).toHaveBeenCalledWith('phase-production-server', '/tmp/test', {
      silent: true,
    });
  });

  it('dir 相对路径按 rootDir 解析后传给 next()', async () => {
    const { ctx } = createMockContext({ dir: 'web' });
    await nextPlugin.setup(ctx);

    expect(mockNextFactory).toHaveBeenCalledWith(
      expect.objectContaining({ dir: path.resolve('/tmp/test', 'web') }),
    );
  });
});

describe('@faapi/next 插件 - Next.js handler 异常兜底', () => {
  /** 构造可直接调用的假 req/res（不走真实 server，便于断言 headersSent 守卫） */
  function makeMockRes(headersSent = false) {
    return {
      headersSent,
      statusCode: 200,
      end: vi.fn(),
    };
  }

  /** flush 微任务队列，让 handler 内部的 .catch 分支执行完 */
  function flush(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
  }

  it('nextHandle reject 时返回 500 "Next.js handler error"，不影响 faapi 路由', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ctx, handlerWrappers } = createMockContext();
    await nextPlugin.setup(ctx);

    const faapiHandler = vi.fn();
    const finalHandler = applyWrappers(faapiHandler, handlerWrappers);
    const res = makeMockRes();

    mockNextHandle.mockRejectedValue(new Error('boom'));
    finalHandler({ url: '/page' } as any, res as any);
    await flush();

    expect(res.statusCode).toBe(500);
    expect(res.end).toHaveBeenCalledWith('Next.js handler error');
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Next.js handler error'),
      expect.any(Error),
    );
    consoleErrorSpy.mockRestore();
  });

  it('nextHandle 返回 undefined（非 Promise）时不报错', async () => {
    const { ctx, handlerWrappers } = createMockContext();
    await nextPlugin.setup(ctx);

    const finalHandler = applyWrappers(vi.fn(), handlerWrappers);
    const res = makeMockRes();

    mockNextHandle.mockReturnValue(undefined);
    finalHandler({ url: '/page' } as any, res as any);
    await flush();

    expect(res.statusCode).toBe(200); // 未被兜底逻辑改写
    expect(res.end).not.toHaveBeenCalled();
  });

  it('res.headersSent 已发出响应时不重复 end（守卫生效）', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ctx, handlerWrappers } = createMockContext();
    await nextPlugin.setup(ctx);

    const finalHandler = applyWrappers(vi.fn(), handlerWrappers);
    const res = makeMockRes(true); // headersSent = true

    mockNextHandle.mockRejectedValue(new Error('boom'));
    finalHandler({ url: '/page' } as any, res as any);
    await flush();

    expect(res.end).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});

describe('@faapi/next 插件 - upgrade handler 缺失', () => {
  /** 让 mockNextFactory 返回无 getUpgradeHandler 的 NextApp（Next.js 旧版本行为） */
  function mockNextWithoutUpgradeHandler(): void {
    mockNextFactory.mockImplementationOnce((() => ({
      getRequestHandler: () => mockNextHandle,
      prepare: async () => {},
    })) as any);
  }

  it('无 nextUpgradeHandler 且非 /api 路径：socket 销毁', async () => {
    mockNextWithoutUpgradeHandler();
    const mockFaapiUpgrade = vi.fn();
    const { ctx, upgradeWrappers } = createMockContext();
    await nextPlugin.setup(ctx);

    const finalUpgrade = upgradeWrappers[0](mockFaapiUpgrade);
    const mockSocket = { destroy: vi.fn() } as unknown as Socket;

    finalUpgrade({ url: '/_next/webpack-hmr' } as any, mockSocket, Buffer.alloc(0));

    expect(mockNextUpgradeHandler).not.toHaveBeenCalled();
    expect(mockFaapiUpgrade).not.toHaveBeenCalled();
    expect(mockSocket.destroy).toHaveBeenCalled();
  });

  it('无 nextUpgradeHandler 且 /api 路径：走 faapi upgradeHandler', async () => {
    mockNextWithoutUpgradeHandler();
    const mockFaapiUpgrade = vi.fn();
    const { ctx, upgradeWrappers } = createMockContext();
    await nextPlugin.setup(ctx);

    const finalUpgrade = upgradeWrappers[0](mockFaapiUpgrade);
    const mockReq = { url: '/api/chat' } as any;
    const mockSocket = { destroy: vi.fn() } as unknown as Socket;
    const mockHead = Buffer.alloc(0);

    finalUpgrade(mockReq, mockSocket, mockHead);

    expect(mockFaapiUpgrade).toHaveBeenCalledWith(mockReq, mockSocket, mockHead);
    expect(mockSocket.destroy).not.toHaveBeenCalled();
  });

  it('/api 路径但 faapi 无 WS 路由（original 为 undefined）：回退 Next.js upgrade', async () => {
    const { ctx, upgradeWrappers } = createMockContext();
    await nextPlugin.setup(ctx);

    // original 为 undefined（faapi 无 WS 路由），/api 前缀命中但无法交给 faapi
    const finalUpgrade = upgradeWrappers[0](undefined);
    const mockSocket = { destroy: vi.fn() } as unknown as Socket;

    finalUpgrade({ url: '/api/chat' } as any, mockSocket, Buffer.alloc(0));

    expect(mockNextUpgradeHandler).toHaveBeenCalled();
    expect(mockSocket.destroy).not.toHaveBeenCalled();
  });

  it('/api 路径、original 为 undefined 且无 nextUpgradeHandler：socket 销毁', async () => {
    mockNextWithoutUpgradeHandler();
    const { ctx, upgradeWrappers } = createMockContext();
    await nextPlugin.setup(ctx);

    const finalUpgrade = upgradeWrappers[0](undefined);
    const mockSocket = { destroy: vi.fn() } as unknown as Socket;

    finalUpgrade({ url: '/api/chat' } as any, mockSocket, Buffer.alloc(0));

    expect(mockSocket.destroy).toHaveBeenCalled();
  });
});

describe('@faapi/next 插件 - next 未安装', () => {
  it('import next 失败时抛出明确的安装提示', async () => {
    vi.resetModules();
    // doMock（非提升）在 resetModules 后对动态 import 生效，模拟 next 未安装
    vi.doMock('next', () => {
      throw new Error("Cannot find package 'next'");
    });

    try {
      const { default: plugin } = await import('./createNextServer');
      const { ctx } = createMockContext();
      await expect(plugin.setup(ctx)).rejects.toThrowError(/next 包未安装/);
    } finally {
      vi.doUnmock('next');
      vi.resetModules();
    }
  });
});
