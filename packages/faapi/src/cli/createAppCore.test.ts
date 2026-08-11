import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAppBase, getApp, type CreateAppOptions } from './createAppCore';
import { compileDevRoutes } from './compileDevRoutes';
import { compileConfig } from './compileConfig';
import { scanRoutes } from '../router/scanRoutes';
import { sortRoutes } from '../router/sortRoutes';
import { serializeRoutes, writeRoutesModule } from './generateRoutes';
import { generateSchemaFiles } from './generateSchemaFiles';
import { invalidateMiddlewareCache } from '../middleware/loadMiddlewares';
import { invalidateProgramCache } from '../ast/createProgram';
import { invalidateSchemaCache } from '../validator/validateInput';

/**
 * createAppBase 测试：dev/prod 共享编排核心
 *
 * 覆盖 createAppBase 独有行为：
 * - 返回 { app, ctx } 双值
 * - ctx.updateRoutes 同步更新 app.routes + routesRef
 * - inject 无服务器注入
 *
 * 基础启动/关闭/配置加载见 createApp.test.ts（createApp 为 createProdApp 别名，委托 createAppBase）。
 */
describe('createAppBase', () => {
  let tempDir: string;
  let savedDist: string | undefined;

  beforeEach(() => {
    tempDir = join(tmpdir(), `faapi-appcore-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    savedDist = process.env.FAAPI_DIST;
    invalidateMiddlewareCache();
    invalidateProgramCache();
  });

  afterEach(async () => {
    if (savedDist === undefined) delete process.env.FAAPI_DIST;
    else process.env.FAAPI_DIST = savedDist;
    invalidateSchemaCache();
    invalidateMiddlewareCache();
    invalidateProgramCache();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeHandler(content?: string) {
    const filePath = join(tempDir, 'src', 'api', 'hello', 'handler.ts');
    mkdirSync(join(filePath, '..'), { recursive: true });
    writeFileSync(
      filePath,
      content ?? `export function GET() { return { hello: 'world' }; }\n`,
      'utf-8',
    );
  }

  async function compileArtifacts(dist: 'dist' | '.faapi') {
    await compileDevRoutes({ rootDir: tempDir, dist });
    await compileConfig({ rootDir: tempDir, dist });
    const { routes, wsRoutes } = await scanRoutes(tempDir, ['src/api/**/*.ts'], dist);
    const sorted = sortRoutes(routes);
    const serialized = serializeRoutes(sorted, wsRoutes, tempDir, dist);
    await writeRoutesModule(serialized, join(tempDir, dist, 'faapi-routes.js'));
    await generateSchemaFiles(sorted, tempDir, dist);
  }

  function options(): CreateAppOptions {
    return { rootDir: tempDir };
  }

  it('返回 { app, ctx } 双值', async () => {
    writeHandler();
    await compileArtifacts('dist');
    const { app, ctx } = await createAppBase(options());
    expect(app).toBeDefined();
    expect(ctx).toBeDefined();
    expect(ctx.rootDir).toBe(tempDir);
    expect(ctx.dist).toBe('dist');
    expect(ctx.server).toBeDefined();
    expect(ctx.routesRef).toBeDefined();
    await app.close();
  });

  it('缺失 faapi-routes.js 抛错', async () => {
    await expect(createAppBase(options())).rejects.toThrow(/faapi-routes\.js 不存在/);
  });

  it('ctx.updateRoutes 同步更新 app.routes 和 routesRef', async () => {
    writeHandler();
    await compileArtifacts('dist');
    const { app, ctx } = await createAppBase(options());
    const originalRoutes = app.routes;
    expect(originalRoutes.length).toBeGreaterThan(0);

    // 模拟热替换：用空数组更新
    ctx.updateRoutes([], []);
    expect(app.routes).toEqual([]);
    expect(ctx.routesRef.current).toEqual([]);
    expect(app.wsRoutes).toEqual([]);
    expect(ctx.routesRef.wsCurrent).toEqual([]);

    await app.close();
  });

  it('inject 无服务器注入请求', async () => {
    // handler 返回 null → 自动包裹为 { data: null } → 200 JSON body
    writeHandler(`export function GET() { return null; }\n`);
    await compileArtifacts('dist');
    const { app } = await createAppBase(options());

    const res = await app.inject({ method: 'GET', path: '/api/hello' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: null });

    await app.close();
  });

  it('FAAPI_DIST 指向 .faapi 时读 dev 产物', async () => {
    writeHandler();
    await compileArtifacts('.faapi');
    process.env.FAAPI_DIST = '.faapi';

    const { app, ctx } = await createAppBase(options());
    expect(ctx.dist).toBe('.faapi');
    expect(app.routes.length).toBeGreaterThan(0);
    await app.close();
  });

  it('options.dist 覆盖环境变量 FAAPI_DIST', async () => {
    writeHandler();
    await compileArtifacts('.faapi');
    // 环境变量指向 dist，options 指向 .faapi —— options 应优先
    process.env.FAAPI_DIST = 'dist';

    const { app, ctx } = await createAppBase({ rootDir: tempDir, dist: '.faapi' });
    expect(ctx.dist).toBe('.faapi');
    expect(app.routes.length).toBeGreaterThan(0);
    await app.close();
  });
});

/**
 * getApp 测试：单例实例访问
 */
describe('getApp', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `faapi-getapp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    invalidateMiddlewareCache();
    invalidateProgramCache();
  });

  afterEach(async () => {
    invalidateSchemaCache();
    invalidateMiddlewareCache();
    invalidateProgramCache();
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function compileArtifacts(dist: 'dist' | '.faapi') {
    await compileDevRoutes({ rootDir: tempDir, dist });
    await compileConfig({ rootDir: tempDir, dist });
    const { routes, wsRoutes } = await scanRoutes(tempDir, ['src/api/**/*.ts'], dist);
    const sorted = sortRoutes(routes);
    const serialized = serializeRoutes(sorted, wsRoutes, tempDir, dist);
    await writeRoutesModule(serialized, join(tempDir, dist, 'faapi-routes.js'));
    await generateSchemaFiles(sorted, tempDir, dist);
  }

  function options(): CreateAppOptions {
    return { rootDir: tempDir };
  }

  it('未初始化时抛错', () => {
    // 先创建+关闭一个 app 清理单例
    return (async () => {
      const filePath = join(tempDir, 'src', 'api', 'hello', 'handler.ts');
      mkdirSync(join(filePath, '..'), { recursive: true });
      writeFileSync(filePath, `export function GET() { return { ok: true }; }\n`, 'utf-8');
      await compileArtifacts('dist');
      const { app } = await createAppBase(options());
      await app.close();
    })().then(() => {
      expect(() => getApp()).toThrow(/No app instance/);
    });
  });

  it('createAppBase 后返回 app 实例', async () => {
    const filePath = join(tempDir, 'src', 'api', 'hello', 'handler.ts');
    mkdirSync(join(filePath, '..'), { recursive: true });
    writeFileSync(filePath, `export function GET() { return { ok: true }; }\n`, 'utf-8');
    await compileArtifacts('dist');

    const { app } = await createAppBase(options());
    expect(getApp()).toBe(app);
    await app.close();
  });

  it('close 后单例置 null（再调 getApp 抛错）', async () => {
    const filePath = join(tempDir, 'src', 'api', 'hello', 'handler.ts');
    mkdirSync(join(filePath, '..'), { recursive: true });
    writeFileSync(filePath, `export function GET() { return { ok: true }; }\n`, 'utf-8');
    await compileArtifacts('dist');

    const { app } = await createAppBase(options());
    expect(getApp()).toBe(app);

    await app.close();

    expect(() => getApp()).toThrow(/No app instance/);
  });

  it('多次 createAppBase 覆盖单例', async () => {
    const filePath = join(tempDir, 'src', 'api', 'hello', 'handler.ts');
    mkdirSync(join(filePath, '..'), { recursive: true });
    writeFileSync(filePath, `export function GET() { return { ok: true }; }\n`, 'utf-8');
    await compileArtifacts('dist');

    const { app: app1 } = await createAppBase(options());
    expect(getApp()).toBe(app1);

    const { app: app2 } = await createAppBase(options());
    expect(getApp()).toBe(app2);
    expect(getApp()).not.toBe(app1);

    // close app2 只清自己（currentApp === app2）
    await app2.close();
    expect(() => getApp()).toThrow(/No app instance/);

    // app1 仍可正常 close（虽然单例已 null，不会误清）
    await app1.close();
  });

  it('单例通过 globalThis + Symbol.for 跨模块实例共享', async () => {
    // 模拟 Next.js Turbopack 场景：RSC chunk 加载的 @faapi/faapi 是另一个模块实例，
    // 模块级变量无法共享，必须通过 globalThis + Symbol.for 跨实例读取。
    // 此测试确保该 key 稳定，防止未来重构破坏 Next.js RSC 场景。
    const filePath = join(tempDir, 'src', 'api', 'hello', 'handler.ts');
    mkdirSync(join(filePath, '..'), { recursive: true });
    writeFileSync(filePath, `export function GET() { return { ok: true }; }\n`, 'utf-8');
    await compileArtifacts('dist');

    const { app } = await createAppBase(options());

    // 通过 Symbol.for('faapi.app.instance') 能从 globalThis 读到同一个 app 实例
    const key = Symbol.for('faapi.app.instance');
    const shared = (globalThis as Record<symbol, unknown>)[key];
    expect(shared).toBe(app);
    expect(getApp()).toBe(shared);

    await app.close();

    // close 后 globalThis 上的引用也被清除
    expect((globalThis as Record<symbol, unknown>)[key]).toBeUndefined();
  });
});

/**
 * app.inject 在 listen() 之后仍可调用（Next.js RSC 场景必需）
 */
describe('app.inject after listen', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(
      tmpdir(),
      `faapi-inject-listen-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tempDir, { recursive: true });
    invalidateMiddlewareCache();
    invalidateProgramCache();
  });

  afterEach(async () => {
    invalidateSchemaCache();
    invalidateMiddlewareCache();
    invalidateProgramCache();
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function compileArtifacts(dist: 'dist' | '.faapi') {
    await compileDevRoutes({ rootDir: tempDir, dist });
    await compileConfig({ rootDir: tempDir, dist });
    const { routes, wsRoutes } = await scanRoutes(tempDir, ['src/api/**/*.ts'], dist);
    const sorted = sortRoutes(routes);
    const serialized = serializeRoutes(sorted, wsRoutes, tempDir, dist);
    await writeRoutesModule(serialized, join(tempDir, dist, 'faapi-routes.js'));
    await generateSchemaFiles(sorted, tempDir, dist);
  }

  function options(): CreateAppOptions {
    return { rootDir: tempDir, port: 13579 };
  }

  it('listen() 之后调 inject 仍返回正确响应（RSC 场景）', async () => {
    const filePath = join(tempDir, 'src', 'api', 'hello', 'handler.ts');
    mkdirSync(join(filePath, '..'), { recursive: true });
    writeFileSync(filePath, `export function GET() { return { hello: 'world' }; }\n`, 'utf-8');
    await compileArtifacts('dist');

    const { app } = await createAppBase(options());
    await app.listen();

    try {
      const res = await app.inject({ method: 'GET', path: '/api/hello' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: { hello: 'world' } });
    } finally {
      await app.close();
    }
  });
});

/**
 * RSC 场景测试：getApp() + app.inject() 组合，模拟 Next.js Server Component 同进程调用
 *
 * 覆盖：
 * - getApp() + inject 组合使用
 * - 请求头透传（cookie / authorization）
 * - 全局中间件执行（鉴权）
 * - POST + body + schema 校验
 * - 业务配置 ctx.config 注入
 */
describe('RSC scenario: getApp() + app.inject()', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `faapi-rsc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    invalidateMiddlewareCache();
    invalidateProgramCache();
  });

  afterEach(async () => {
    invalidateSchemaCache();
    invalidateMiddlewareCache();
    invalidateProgramCache();
    rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * 编译产物 + 生成 faapi-routes.js + zod.js
   *
   * @param configContent 可选，faapi.config.ts 内容（含中间件/业务配置等）
   * @param handlerFiles handler 文件列表 [{ path, content }]
   */
  async function setupApp(
    configContent: string,
    handlerFiles: Array<{ relPath: string; content: string }>,
  ) {
    // 写 faapi.config.ts（可选）
    if (configContent) {
      writeFileSync(join(tempDir, 'faapi.config.ts'), configContent, 'utf-8');
    }

    // 写 handler 文件
    for (const f of handlerFiles) {
      const absPath = join(tempDir, f.relPath);
      mkdirSync(join(absPath, '..'), { recursive: true });
      writeFileSync(absPath, f.content, 'utf-8');
    }

    // 编译产物
    await compileDevRoutes({ rootDir: tempDir, dist: 'dist' });
    await compileConfig({ rootDir: tempDir, dist: 'dist' });
    const { routes, wsRoutes } = await scanRoutes(tempDir, ['src/api/**/*.ts'], 'dist');
    const sorted = sortRoutes(routes);
    const serialized = serializeRoutes(sorted, wsRoutes, tempDir, 'dist');
    await writeRoutesModule(serialized, join(tempDir, 'dist', 'faapi-routes.js'));
    await generateSchemaFiles(sorted, tempDir, 'dist');
  }

  async function startApp(): Promise<{
    app: Awaited<ReturnType<typeof createAppBase>>['app'];
    port: number;
  }> {
    const port = 20000 + Math.floor(Math.random() * 10000);
    const { app } = await createAppBase({ rootDir: tempDir, port });
    await app.listen();
    return { app, port };
  }

  it('getApp() + inject 组合：getApp 返回的实例与 inject 一致', async () => {
    await setupApp('', [
      {
        relPath: 'src/api/hello/handler.ts',
        content: `export function GET() { return { hello: 'world' }; }\n`,
      },
    ]);

    const { app } = await startApp();
    try {
      // RSC 场景：业务方不持有 app 引用，通过 getApp() 获取
      expect(getApp()).toBe(app);

      const res = await getApp().inject({ method: 'GET', path: '/api/hello' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: { hello: 'world' } });
    } finally {
      await app.close();
    }
  });

  it('请求头透传：cookie 和 authorization 透传到 handler', async () => {
    await setupApp('', [
      {
        relPath: 'src/api/me/handler.ts',
        content: `export function GET(headers: Headers) {
  return {
    cookie: headers.get('cookie'),
    authorization: headers.get('authorization'),
  };
}\n`,
      },
    ]);

    const { app } = await startApp();
    try {
      // 模拟 RSC 中从 next/headers 读 cookie/auth 后透传
      const res = await getApp().inject({
        method: 'GET',
        path: '/api/me',
        headers: {
          cookie: 'session=abc123; user=alice',
          authorization: 'Bearer token-xyz',
        },
      });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        data: {
          cookie: 'session=abc123; user=alice',
          authorization: 'Bearer token-xyz',
        },
      });
    } finally {
      await app.close();
    }
  });

  it('全局中间件执行：鉴权中间件拦截无 token 请求', async () => {
    // faapi.config.ts 配置全局鉴权中间件
    await setupApp(
      `import type { FaapiConfig } from '@faapi/faapi';
export default {
  middlewares: [
    async (ctx, next) => {
      const token = ctx.headers.get('authorization');
      if (!token) {
        return ctx.fail({ status: 401, code: 'UNAUTHORIZED', message: 'token required' });
      }
      ctx.user = { id: 1, name: 'alice' };  // 塞 user 到 ctx
      await next();
    },
  ],
} satisfies FaapiConfig;
`,
      [
        {
          relPath: 'src/api/me/handler.ts',
          content: `export function GET(ctx) {
  return { userId: ctx.user.id, name: ctx.user.name };
}\n`,
        },
      ],
    );

    const { app } = await startApp();
    try {
      // 1. 无 token → 401 拦截
      const noTokenRes = await getApp().inject({ method: 'GET', path: '/api/me' });
      expect(noTokenRes.status).toBe(401);
      expect(noTokenRes.body).toEqual({
        error: { code: 'UNAUTHORIZED', message: 'token required' },
      });

      // 2. 有 token → 通过中间件 + handler 拿到 ctx.user
      const withTokenRes = await getApp().inject({
        method: 'GET',
        path: '/api/me',
        headers: { authorization: 'Bearer token-xyz' },
      });
      expect(withTokenRes.status).toBe(200);
      expect(withTokenRes.body).toEqual({ data: { userId: 1, name: 'alice' } });
    } finally {
      await app.close();
    }
  });

  it('POST + body + schema 校验：合法 body 通过，非法 body 返回 422', async () => {
    await setupApp('', [
      {
        relPath: 'src/api/user/handler.ts',
        content: `export interface CreateUserBody { name: string; age: number }
export function POST(body: CreateUserBody) {
  return { created: true, name: body.name, age: body.age };
}\n`,
      },
    ]);

    const { app } = await startApp();
    try {
      // 1. 合法 body → 200
      const okRes = await getApp().inject({
        method: 'POST',
        path: '/api/user',
        body: { name: 'Alice', age: 30 },
      });
      expect(okRes.status).toBe(200);
      expect(okRes.body).toEqual({
        data: { created: true, name: 'Alice', age: 30 },
      });

      // 2. 缺字段 → 422
      const badRes = await getApp().inject({
        method: 'POST',
        path: '/api/user',
        body: { name: 'Alice' }, // 缺 age
      });
      expect(badRes.status).toBe(422);
      expect((badRes.body as { error: unknown }).error).toBeDefined();
    } finally {
      await app.close();
    }
  });

  it('业务配置注入：ctx.config 在 inject 中可用', async () => {
    // faapi.config.ts 带业务配置
    await setupApp(
      `export default {
  db: { host: 'db.example.com', port: 5432 },
  featureFlags: { newApi: true },
};\n`,
      [
        {
          relPath: 'src/api/config/handler.ts',
          content: `export function GET(ctx) {
  return {
    dbHost: ctx.config.db.host,
    dbPort: ctx.config.db.port,
    newApi: ctx.config.featureFlags.newApi,
  };
}\n`,
        },
      ],
    );

    const { app } = await startApp();
    try {
      const res = await getApp().inject({ method: 'GET', path: '/api/config' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        data: {
          dbHost: 'db.example.com',
          dbPort: 5432,
          newApi: true,
        },
      });
    } finally {
      await app.close();
    }
  });
});
