/**
 * E2E 测试：createTestServer 在 vitest 下识别 @/ 别名
 *
 * 模拟 sso 项目场景：业务方 handler 内 `import { db } from '@/lib/db'`，
 * 在 vitest 下 createTestServer 加载 handler 时需要走 Vite pipeline
 * 才能识别 @/ 别名（参考 TODO-faapi-gaps.md）。
 *
 * 此文件不写 vi.mock，仅验证别名解析 + 真实模块加载。
 * vi.mock 生效场景见 testServer.e2e.alias.mock.test.ts。
 *
 * 前置：faapi 的 vitest.config.ts 配了 `@` alias 指向 fixtures/api-alias/src
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestServer, type TestServer } from './testServer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.resolve(__dirname, '../fixtures/api-alias');

describe('createTestServer 在 vitest 下识别 @/ 别名（不 mock）', () => {
  let ts: TestServer;

  beforeAll(async () => {
    ts = await createTestServer({ rootDir: FIXTURE_ROOT });
  });

  afterAll(async () => {
    await ts.close();
  });

  it('handler 加载成功（别名解析），路由表非空', () => {
    expect(ts.routes.length).toBeGreaterThan(0);
    const aliasRoute = ts.routes.find((r) => r.urlPath === '/api/alias');
    expect(aliasRoute).toBeDefined();
    expect(aliasRoute?.method).toBe('GET');
  });

  it('GET /api/alias 返回真实数据（@/lib/db 别名解析成功）', async () => {
    const res = await fetch(`${ts.baseUrl}/api/alias`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe('real');
    expect(body.user).toBeDefined();
    expect(body.user.id).toBe('real-user-id');
    expect(body.user.username).toBe('real-user');
  });

  it('GET /api/alias?id=<real-user-id> 通过别名模块查询用户', async () => {
    const res = await fetch(`${ts.baseUrl}/api/alias?id=real-user-id`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe('real');
    expect(body.user.id).toBe('real-user-id');
  });

  it('GET /api/alias?id=<unknown> 返回 user=null', async () => {
    const res = await fetch(`${ts.baseUrl}/api/alias?id=unknown`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe('real');
    expect(body.user).toBeNull();
  });
});
