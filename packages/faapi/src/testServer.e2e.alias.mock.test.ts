/**
 * E2E 测试：createTestServer 在 vitest 下让 vi.mock 生效
 *
 * 模拟 sso 项目场景：业务方用 `vi.mock('@/lib/db', ...)` mock 数据库，
 * createTestServer 内部加载的 handler 应看到 mock 后的模块。
 *
 * vi.mock 是 hoist 的，整个文件共享 mock 行为。
 * 不 mock 的场景见 testServer.e2e.alias.test.ts。
 *
 * 前置：faapi 的 vitest.config.ts 配了 `@` alias 指向 fixtures/api-alias/src
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestServer, type TestServer } from './testServer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.resolve(__dirname, '../fixtures/api-alias');

// vi.mock 必须 hoist 到顶层：替换 @/lib/db 的 db.source 为 'mocked'
// 验证 createTestServer 内部 importWithCacheBust 走 Vite pipeline 时
// vi.mock 对加载的 handler 生效
// 注：用 typeof import('@/lib/db') 在 tsc 下因 faapi tsconfig 未配 paths 失败，
// 改用运行时类型推断（actual 类型由 Vite 解析 @/lib/db 后给出）
vi.mock('@/lib/db', async (importOriginal) => {
  const actual = (await importOriginal()) as {
    db: { user: unknown; source: string };
    findUser: (id: string) => Promise<unknown>;
  };
  return {
    ...actual,
    db: { ...actual.db, source: 'mocked' },
  };
});

describe('createTestServer 在 vitest 下让 vi.mock 生效', () => {
  let ts: TestServer;

  beforeAll(async () => {
    ts = await createTestServer({ rootDir: FIXTURE_ROOT });
  });

  afterAll(async () => {
    await ts.close();
  });

  it('handler 加载成功（vi.mock 不影响路由扫描）', () => {
    expect(ts.routes.length).toBeGreaterThan(0);
    const aliasRoute = ts.routes.find((r) => r.urlPath === '/api/alias');
    expect(aliasRoute).toBeDefined();
  });

  it('GET /api/alias 返回 mocked 数据（vi.mock 生效）', async () => {
    const res = await fetch(`${ts.baseUrl}/api/alias`);
    expect(res.status).toBe(200);
    const body = await res.json();
    // vi.mock 把 db.source 替换为 'mocked'
    expect(body.source).toBe('mocked');
    // 实际数据仍透传 actual.db.user（mock 时 ...actual.db 展开）
    expect(body.user.id).toBe('real-user-id');
  });

  it('GET /api/alias?id=<real-user-id> 走 mocked 模块', async () => {
    const res = await fetch(`${ts.baseUrl}/api/alias?id=real-user-id`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe('mocked');
  });
});
