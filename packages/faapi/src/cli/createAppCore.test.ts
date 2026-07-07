import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAppBase, type CreateAppOptions } from './createAppCore';
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
    // handler 返回 null → 204 无 body → sendNodeResponse 走 res.end() 不走 pipe
    // （inject 的 mockRes 非 Writable，不支持 pipe）
    writeHandler(`export function GET() { return null; }\n`);
    await compileArtifacts('dist');
    const { app } = await createAppBase(options());

    const res = await app.inject({ method: 'GET', path: '/api/hello' });
    expect(res.status).toBe(204);

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
