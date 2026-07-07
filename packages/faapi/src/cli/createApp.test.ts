import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp, type CreateAppOptions } from './createApp';
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
 * createApp 测试：prod 模式启动 API（createApp 为 createProdApp 的别名）
 *
 * createApp 读 <dist>/faapi-routes.js + <dist>/faapi-config.js，无 reloadRoutes。
 * dist 由 process.env.FAAPI_DIST 决定（默认 'dist'）。
 *
 * 覆盖：
 * - 统一水合路由清单（默认 dist / FAAPI_DIST 指向 .faapi）
 * - listen/close 生命周期
 * - 配置自动加载
 * - 缺失产物的错误处理
 *
 * dev 专用能力（reloadRoutes 热替换）见 createDevApp.test.ts。
 */
describe('createApp', () => {
  let tempDir: string;
  let savedDist: string | undefined;

  beforeEach(() => {
    tempDir = join(
      tmpdir(),
      `faapi-createapp-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
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

  /** 写一个 handler.ts 到 src/{routePath} */
  function writeHandler(routePath = 'api/hello/handler.ts', content?: string) {
    const filePath = join(tempDir, 'src', routePath);
    mkdirSync(join(filePath, '..'), { recursive: true });
    writeFileSync(
      filePath,
      content ?? `export function GET() { return { hello: 'world' }; }\n`,
      'utf-8',
    );
  }

  /** 编译产物三元组到指定 dist：.js + faapi-config.js + faapi-routes.js + zod.js */
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

  it('统一水合路由清单（默认 dist）', async () => {
    writeHandler();
    await compileArtifacts('dist');

    const app = await createApp(options());
    expect(app.routes.length).toBeGreaterThan(0);
    expect(app.routes[0].urlPath).toBe('/api/hello');
    expect(app.routes[0].method).toBe('GET');
    await app.close();
  });

  it('通过 FAAPI_DIST 指向 .faapi', async () => {
    writeHandler();
    await compileArtifacts('.faapi');
    process.env.FAAPI_DIST = '.faapi';

    const app = await createApp(options());
    expect(app.routes.length).toBeGreaterThan(0);
    expect(app.routes[0].urlPath).toBe('/api/hello');
    await app.close();
  });

  it('listen 启动 server，close 关闭', async () => {
    writeHandler();
    await compileArtifacts('dist');

    const app = await createApp(options());
    expect(app.server).toBeNull();

    const server = await app.listen(0);
    expect(server.listening).toBe(true);
    expect(app.server).toBe(server);

    await app.close();
    expect(server.listening).toBe(false);
  });

  it('缺失 faapi-routes.js 抛错', async () => {
    await expect(createApp(options())).rejects.toThrow(/faapi-routes\.js 不存在/);
  });

  it('自动加载配置文件', async () => {
    writeHandler();
    writeFileSync(
      join(tempDir, 'faapi.config.ts'),
      `export default { db: { host: 'localhost', port: 5432 } };\n`,
      'utf-8',
    );
    await compileArtifacts('dist');

    const app = await createApp(options());
    expect(app.routes.length).toBeGreaterThan(0);
    await app.close();
  });
});
