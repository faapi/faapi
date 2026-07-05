import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDevApp } from './createDevApp';
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
 * createDevApp 测试：dev 模式启动 API（含 reloadRoutes 热替换）
 *
 * createDevApp 在 createAppBase 基础上增加 reloadRoutes（重新扫描 + 清缓存 + 更新引用）。
 * 由 devCommand 直接调用，devCommand 持有 app 引用传给 watcher。
 *
 * 覆盖：
 * - 水合路由清单
 * - listen/close 生命周期
 * - reloadRoutes 热替换（新增路由后重新扫描生效）
 * - 缺失产物的错误处理
 * - 配置自动加载
 */
describe('createDevApp', () => {
  let tempDir: string;
  let savedOutDir: string | undefined;

  beforeEach(() => {
    tempDir = join(
      tmpdir(),
      `faapi-createdevapp-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
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

  function writeHandler(routePath = 'api/hello/handler.ts', content?: string) {
    const filePath = join(tempDir, 'src', routePath);
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

  it('水合路由清单', async () => {
    writeHandler();
    await compileArtifacts('dist');

    const app = await createDevApp({ rootDir: tempDir });
    expect(app.routes.length).toBeGreaterThan(0);
    expect(app.routes[0].urlPath).toBe('/api/hello');
    expect(app.routes[0].method).toBe('GET');
    await app.close();
  });

  it('listen 启动 server，close 关闭', async () => {
    writeHandler();
    await compileArtifacts('dist');

    const app = await createDevApp({ rootDir: tempDir });
    const server = await app.listen(0);
    expect(server.listening).toBe(true);
    await app.close();
    expect(server.listening).toBe(false);
  });

  it('reloadRoutes 重新扫描路由（新增 handler 后生效）', async () => {
    writeHandler();
    await compileArtifacts('dist');

    const app = await createDevApp({ rootDir: tempDir });
    const initialCount = app.routes.length;

    // 新增路由 + 重新编译产物（watcher 触发时的行为模拟）
    writeHandler('api/user/handler.ts');
    await compileArtifacts('dist');

    await app.reloadRoutes();
    expect(app.routes.length).toBe(initialCount + 1);
    await app.close();
  });

  it('缺失 faapi-routes.js 抛错', async () => {
    await expect(createDevApp({ rootDir: tempDir })).rejects.toThrow(/faapi-routes\.js 不存在/);
  });

  it('自动加载配置文件', async () => {
    writeHandler();
    writeFileSync(
      join(tempDir, 'faapi.config.ts'),
      `export default { db: { host: 'localhost', port: 5432 } };\n`,
      'utf-8',
    );
    await compileArtifacts('dist');

    const app = await createDevApp({ rootDir: tempDir });
    expect(app.routes.length).toBeGreaterThan(0);
    await app.close();
  });
});
