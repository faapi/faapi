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
  let savedOutDir: string | undefined;

  beforeEach(() => {
    tempDir = join(tmpdir(), `faapi-appcore-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    savedOutDir = process.env.FAAPI_OUT_DIR;
    invalidateMiddlewareCache();
    invalidateProgramCache();
  });

  afterEach(async () => {
    if (savedOutDir === undefined) delete process.env.FAAPI_OUT_DIR;
    else process.env.FAAPI_OUT_DIR = savedOutDir;
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

  async function compileArtifacts(outDir: 'dist' | '.faapi/dev') {
    await compileDevRoutes({ rootDir: tempDir, appDir: 'src', outDir });
    await compileConfig({ rootDir: tempDir, outDir });
    const { routes, wsRoutes } = await scanRoutes(tempDir, ['src/api/**/*.ts'], 'src', outDir);
    const sorted = sortRoutes(routes);
    const serialized = serializeRoutes(sorted, wsRoutes, tempDir, 'src', outDir);
    await writeRoutesModule(serialized, join(tempDir, outDir, 'faapi-routes.js'));
    await generateSchemaFiles(sorted, tempDir, 'src', outDir);
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
    expect(ctx.outDir).toBe('dist');
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

  it('FAAPI_OUT_DIR 指向 .faapi/dev 时读 dev 产物', async () => {
    writeHandler();
    await compileArtifacts('.faapi/dev');
    process.env.FAAPI_OUT_DIR = '.faapi/dev';

    const { app, ctx } = await createAppBase(options());
    expect(ctx.outDir).toBe('.faapi/dev');
    expect(app.routes.length).toBeGreaterThan(0);
    await app.close();
  });
});
