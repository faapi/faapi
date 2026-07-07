import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProdApp, type CreateAppOptions } from './createProdApp';
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
 * createProdApp 测试：prod 模式启动 API
 *
 * createProdApp 委托 createAppBase 仅返回 AppBase（无 ctx）。
 * createApp.test.ts 通过别名 createApp 覆盖了基础行为，本文件验证 createProdApp 作为独立导出的契约。
 */
describe('createProdApp', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `faapi-prodapp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

  function writeHandler() {
    const filePath = join(tempDir, 'src', 'api', 'hello', 'handler.ts');
    mkdirSync(join(filePath, '..'), { recursive: true });
    writeFileSync(filePath, `export function GET() { return { hello: 'world' }; }\n`, 'utf-8');
  }

  async function compileArtifacts() {
    await compileDevRoutes({ rootDir: tempDir, dist: 'dist' });
    await compileConfig({ rootDir: tempDir, dist: 'dist' });
    const { routes, wsRoutes } = await scanRoutes(tempDir, ['src/api/**/*.ts'], 'dist');
    const sorted = sortRoutes(routes);
    const serialized = serializeRoutes(sorted, wsRoutes, tempDir, 'dist');
    await writeRoutesModule(serialized, join(tempDir, 'dist', 'faapi-routes.js'));
    await generateSchemaFiles(sorted, tempDir, 'dist');
  }

  function options(): CreateAppOptions {
    return { rootDir: tempDir };
  }

  it('返回 AppBase（含 listen/close/inject，无 reloadRoutes）', async () => {
    writeHandler();
    await compileArtifacts();
    const app = await createProdApp(options());
    expect(app.listen).toBeInstanceOf(Function);
    expect(app.close).toBeInstanceOf(Function);
    expect(app.inject).toBeInstanceOf(Function);
    expect((app as unknown as Record<string, unknown>).reloadRoutes).toBeUndefined();
    await app.close();
  });

  it('缺失 faapi-routes.js 抛错', async () => {
    await expect(createProdApp(options())).rejects.toThrow(/faapi-routes\.js 不存在/);
  });

  it('水合路由清单', async () => {
    writeHandler();
    await compileArtifacts();
    const app = await createProdApp(options());
    expect(app.routes.length).toBeGreaterThan(0);
    expect(app.routes[0].urlPath).toBe('/api/hello');
    expect(app.routes[0].method).toBe('GET');
    await app.close();
  });
});
