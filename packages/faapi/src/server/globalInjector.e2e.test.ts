import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { scanRoutes } from '../router/scanRoutes';
import { sortRoutes } from '../router/sortRoutes';
import { createServer } from './createServer';
import { generateSchemaFiles } from '../cli/generateSchemaFiles';
import { invalidateSchemaCache } from '../validator/validateInput';
import type { Server } from 'node:http';
import type { InjectorMap } from '../middleware/injectorTypes';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, '../../fixtures/api-basic');

let server: Server | null = null;
let baseUrl: string;
let schemaDist: string;

/**
 * 全局注入器：db 返回固定 rows，globalUser 返回全局用户
 *
 * 测试覆盖：
 * 1. 全局注入器对无目录注入器的路由生效（/api/inject 的 db 参数）
 * 2. 目录注入器覆盖全局同名（/api/admin/profile 的 user 注入器覆盖 globalUser）
 */
const globalInjectors: InjectorMap = {
  db: () => ({ query: () => ['row1', 'row2'] }),
  globalUser: () => ({ name: 'global-alice', role: 'global-admin' }),
};

beforeAll(async () => {
  const { routes } = await scanRoutes(FIXTURES_DIR, ['api/**/*.ts']);
  const sorted = sortRoutes(routes);
  // 生成 zod.js 到临时目录（createServer 运行时按 route.filePath + dist 计算 zod.js 路径）
  schemaDist = await fs.mkdtemp(path.join(os.tmpdir(), 'faapi-e2e-inj-schema-'));
  await generateSchemaFiles(sorted, FIXTURES_DIR, schemaDist);
  const { server: srv } = createServer({
    routes: sorted,
    rootDir: FIXTURES_DIR,
    dist: schemaDist,
    injectors: globalInjectors,
  });

  await new Promise<void>((resolve, reject) => {
    srv.listen(0, () => {
      const addr = srv.address();
      if (typeof addr === 'object' && addr !== null) {
        const port = addr.port;
        baseUrl = `http://localhost:${port}`;
        server = srv;
        resolve();
      } else {
        reject(new Error('Failed to get server address'));
      }
    });
  });
});

afterAll(async () => {
  if (server) {
    const anyServer = server as Server & {
      closeAllConnections?: () => void;
    };
    anyServer.closeAllConnections?.();
    await new Promise<void>((resolve) => {
      server!.close(() => resolve());
    });
    server = null;
  }
  if (schemaDist) {
    await fs.rm(schemaDist, { recursive: true, force: true });
  }
  invalidateSchemaCache();
});

describe('全局注入器', () => {
  it('无目录注入器的路由：handler 参数由全局注入器提供', async () => {
    // /api/inject 的 GET(db) 无目录 middlewares.ts，db 来自全局注入器
    const res = await fetch(`${baseUrl}/api/inject`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      injected: 'global-db',
      rows: ['row1', 'row2'],
    });
  });

  it('目录注入器覆盖全局同名', async () => {
    // /api/admin/profile 有目录 user 注入器（返回 { name: 'alice', role: 'admin' }）
    // 全局 globalUser 与目录 user 不同名，不冲突
    // 这里验证目录 user 注入器正常工作，全局注入器不影响
    const res = await fetch(`${baseUrl}/api/admin/profile`, {
      headers: { authorization: 'Bearer test' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ name: 'alice', role: 'admin' });
  });
});

describe('全局注入器与目录注入器同名覆盖', () => {
  let overrideServer: Server | null = null;
  let overrideBaseUrl: string;

  beforeAll(async () => {
    const { routes } = await scanRoutes(FIXTURES_DIR, ['api/**/*.ts']);
    const sorted = sortRoutes(routes);
    // 全局定义 user 注入器，目录 profile/middlewares.ts 也有 user 注入器
    // 目录应覆盖全局，handler 拿到目录的 alice 而非全局的 global-alice
    const { server: srv } = createServer({
      routes: sorted,
      rootDir: FIXTURES_DIR,
      dist: schemaDist,
      injectors: {
        user: () => ({ name: 'global-alice', role: 'global-admin' }),
      },
    });
    await new Promise<void>((resolve) => {
      srv.listen(0, () => {
        const addr = srv.address();
        if (typeof addr === 'object' && addr !== null) {
          overrideBaseUrl = `http://localhost:${addr.port}`;
          overrideServer = srv;
          resolve();
        }
      });
    });
  });

  afterAll(async () => {
    if (overrideServer) {
      const anyServer = overrideServer as Server & {
        closeAllConnections?: () => void;
      };
      anyServer.closeAllConnections?.();
      await new Promise<void>((resolve) => {
        overrideServer!.close(() => resolve());
      });
      overrideServer = null;
    }
  });

  it('目录 user 注入器覆盖全局 user 注入器', async () => {
    const res = await fetch(`${overrideBaseUrl}/api/admin/profile`, {
      headers: { authorization: 'Bearer test' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // 目录注入器返回 alice（来自 profile/middlewares.ts），全局 global-alice 被覆盖
    expect(body).toEqual({ name: 'alice', role: 'admin' });
  });
});
