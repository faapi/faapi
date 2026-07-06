import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import type { Server } from 'node:http';
import { loadConfig } from '@faapi/faapi';
import { scanRoutes } from '@faapi/faapi/src/router/scanRoutes';
import { sortRoutes } from '@faapi/faapi/src/router/sortRoutes';
import { detectRouteConflicts } from '@faapi/faapi/src/router/detectRouteConflicts';
import { compileConfig } from '@faapi/faapi/src/cli/compileConfig';
import { generateSchemaFiles } from '@faapi/faapi/src/cli/generateSchemaFiles';
import { invalidateSchemaCache } from '@faapi/faapi/src/validator/validateInput';
import { createServer } from '@faapi/faapi/src/server/createServer';
import { loadPlugins } from '@faapi/faapi/src/cli/loadPlugins';
import { applyPluginWrappers } from '@faapi/faapi/src/server/startServer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, '../fixtures/with-nextjs');

// fixture 路由在 api/ 下（与 Next.js 的 app/ 目录分离），测试中显式传 patterns
const PATTERNS = ['api/**/*.ts'];
const APP_DIR = '.';

/** FaapiConfig 的内置 key 集合（排除自定义业务配置） */
const FAAPI_CONFIG_KEYS = new Set([
  'cors',
  'lifecycle',
  'middlewares',
  'injectors',
  'extendContext',
  'plugins',
  'helmet',
  'bodyLimit',
  'logger',
  'http2',
]);

function isFaapiConfigKey(key: string): boolean {
  return FAAPI_CONFIG_KEYS.has(key);
}

// 共享一个 server 实例（Next.js 启动较重，避免每个测试都重启）
let server: Server;
let baseUrl: string;
let wsBaseUrl: string;
let schemaOutDir: string;

beforeAll(async () => {
  // E2E 从源码生成配置产物（与 faapi dev 行为一致）
  // 1. 编译配置文件 → fixtures/.faapi-e2e-schema/faapi-config.js
  schemaOutDir = path.join(FIXTURES_DIR, '.faapi-e2e-schema');
  await fs.mkdir(schemaOutDir, { recursive: true });
  await compileConfig({ rootDir: FIXTURES_DIR, outDir: schemaOutDir });
  const config = await loadConfig(FIXTURES_DIR, schemaOutDir);

  // 2. 扫描路由（HTTP + WebSocket）
  const { routes: rawRoutes, wsRoutes } = await scanRoutes(FIXTURES_DIR, PATTERNS, APP_DIR);
  const routes = sortRoutes(rawRoutes);

  // 3. 路由冲突检测（仅警告）
  const conflicts = detectRouteConflicts(routes);
  for (const conflict of conflicts) {
    console.warn(`! 路由冲突: ${conflict.method} ${conflict.urlPath}`);
  }

  // 4. 生成 zod.js 到 fixtures 内的临时目录（每个 handler 一个 schema 文件，与 faapi build 行为一致）
  //    放在 fixtures 内是为了让 zod.js 能解析到 node_modules 中的 zod 包
  if (routes.length > 0) {
    await generateSchemaFiles(routes, FIXTURES_DIR, APP_DIR, schemaOutDir);
  }

  // 5. 创建 server（不 listen）
  server = createServer({
    routes,
    rootDir: FIXTURES_DIR,
    appDir: APP_DIR,
    outDir: schemaOutDir,
    cors: config?.cors,
    onError: config?.lifecycle?.onError,
    config: config ?? undefined,
    wsRoutes,
    middlewares: config?.middlewares,
    injectors: config?.injectors,
  }).server;

  // 6. 加载插件并应用 handler 包装（在 server.listen 之前，与 CLI 行为一致）
  const pluginConfig = config
    ? Object.fromEntries(Object.entries(config).filter(([k]) => !isFaapiConfigKey(k)))
    : {};
  const { handlerWrappers, upgradeWrappers } = await loadPlugins(config?.plugins, {
    rootDir: FIXTURES_DIR,
    routes,
    server,
    config: pluginConfig,
  });
  applyPluginWrappers(server, handlerWrappers, upgradeWrappers);

  // 7. listen
  baseUrl = await new Promise<string>((resolve, reject) => {
    server.listen(0, () => {
      const addr = server.address();
      if (typeof addr === 'object' && addr !== null) {
        resolve(`http://localhost:${addr.port}`);
      } else {
        reject(new Error('Failed to get server address'));
      }
    });
  });
  wsBaseUrl = baseUrl.replace('http', 'ws');
}, 60000);

afterAll(async () => {
  if (typeof (server as any).closeAllConnections === 'function') {
    (server as any).closeAllConnections();
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (schemaOutDir) {
    await fs.rm(schemaOutDir, { recursive: true, force: true });
  }
  invalidateSchemaCache();
}, 30000);

describe('@faapi/next e2e - HTTP 分流', () => {
  it('/api/health 走 faapi 返回 JSON', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ status: 'ok', source: 'faapi' });
  });

  it('/ 走 Next.js 渲染首页 HTML', async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Next.js + faapi E2E Fixture');
  });

  it('/about 走 Next.js 渲染子页面', async () => {
    const res = await fetch(`${baseUrl}/about`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('About');
    expect(html).toContain('About page rendered by Next.js');
  });

  it('/dynamic/foo 走 Next.js 动态路由渲染', async () => {
    const res = await fetch(`${baseUrl}/dynamic/foo`);
    expect(res.status).toBe(200);
    const html = await res.text();
    // React 在文本节点间插入注释标记，分别检查关键词
    expect(html).toContain('Dynamic:');
    expect(html).toContain('foo');
    expect(html).toContain('Next.js dynamic route');
  });

  it('/api2 不匹配 /api 前缀，走 Next.js（无此页面返回 404）', async () => {
    const res = await fetch(`${baseUrl}/api2`);
    expect(res.status).toBe(404);
  });
});

describe('@faapi/next e2e - faapi API 路由', () => {
  it('/api/user/:id 动态路由返回 faapi 数据', async () => {
    const res = await fetch(`${baseUrl}/api/user/123`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ id: '123', source: 'faapi' });
  });

  it('/api/user POST 正常请求返回创建结果', async () => {
    const res = await fetch(`${baseUrl}/api/user`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'alice' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ created: true, name: 'alice', source: 'faapi' });
  });

  it('/api/user POST 缺 name 必填字段返回 400', async () => {
    const res = await fetch(`${baseUrl}/api/user`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    // 缺少必填字段 → 400 (MISSING_FIELD) 或 422 (TYPE_MISMATCH)
    expect([400, 422]).toContain(res.status);
  });

  it('/api/not-exist 未匹配 faapi 路由返回 404', async () => {
    const res = await fetch(`${baseUrl}/api/not-exist`);
    expect(res.status).toBe(404);
  });
});

describe('@faapi/next e2e - WebSocket 分流', () => {
  it('/api/chat WS 连接成功并收到 onOpen 消息', async () => {
    const ws = new WebSocket(`${wsBaseUrl}/api/chat`);

    // 在 open 之前注册 message 监听器，避免竞态
    const messages: string[] = [];
    ws.on('message', (data) => messages.push(data.toString()));

    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

    // 等待 onOpen 消息（最多 10s）
    const deadline = Date.now() + 10000;
    while (messages.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(messages.length).toBeGreaterThan(0);
    expect(JSON.parse(messages[0])).toEqual({ source: 'faapi-ws', connected: true });

    ws.close();
  });

  it('/api/chat WS echo 消息', async () => {
    const ws = new WebSocket(`${wsBaseUrl}/api/chat`);

    // 在 open 之前注册 message 监听器，收集所有消息避免竞态
    const messages: string[] = [];
    ws.on('message', (data) => messages.push(data.toString()));

    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

    // 等待 onOpen 消息
    const deadline1 = Date.now() + 10000;
    while (messages.length === 0 && Date.now() < deadline1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(messages.length).toBeGreaterThan(0);
    const openMsg = messages.shift()!;
    expect(JSON.parse(openMsg)).toEqual({ source: 'faapi-ws', connected: true });

    // 发送消息
    ws.send('hello');

    // 等待 echo
    const deadline2 = Date.now() + 10000;
    while (messages.length === 0 && Date.now() < deadline2) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(messages.length).toBeGreaterThan(0);
    const echo = messages.shift()!;
    expect(JSON.parse(echo)).toEqual({ source: 'faapi-ws', echo: 'hello' });

    ws.close();
  });

  it('未匹配 WS 路径升级失败（socket 销毁）', async () => {
    const ws = new WebSocket(`${wsBaseUrl}/api/not-exist-ws`);
    await expect(
      new Promise<void>((resolve, reject) => {
        ws.on('open', () => resolve());
        ws.on('error', () => reject(new Error('upgrade failed')));
        ws.on('unexpected-response', () => reject(new Error('upgrade failed')));
      }),
    ).rejects.toThrow('upgrade failed');
    ws.close();
  });
});
