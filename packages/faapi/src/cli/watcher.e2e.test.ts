import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DevApp } from './createDevApp';
import { createDevApp } from './createDevApp';
import { startWatcher } from './watcher';
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
 * watcher 热替换 e2e 测试
 *
 * 验证文件变化 → debounce → 增量编译 + reloadRoutes 调用 的完整链路。
 * 使用真实的 chokidar 监听 + 真实文件系统变化。
 */
describe('watcher 热替换', () => {
  let tempDir: string;
  let savedOutDir: string | undefined;

  beforeEach(() => {
    tempDir = join(tmpdir(), `faapi-watcher-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    savedOutDir = process.env.FAAPI_OUT_DIR;
    process.env.FAAPI_OUT_DIR = '.faapi/dev';
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

  it('handler.ts 变化触发 reloadRoutes', async () => {
    const handlerPath = join(tempDir, 'src', 'api', 'hello', 'handler.ts');
    mkdirSync(join(handlerPath, '..'), { recursive: true });
    writeFileSync(handlerPath, `export function GET() { return { hello: 'world' }; }\n`, 'utf-8');

    // 编译产物三元组
    await compileDevRoutes({ rootDir: tempDir, appDir: 'src', outDir: '.faapi/dev' });
    await compileConfig({ rootDir: tempDir, outDir: '.faapi/dev' });
    const { routes, wsRoutes } = await scanRoutes(
      tempDir,
      ['src/api/**/*.ts'],
      'src',
      '.faapi/dev',
    );
    const sorted = sortRoutes(routes);
    const serialized = serializeRoutes(sorted, wsRoutes, tempDir, 'src', '.faapi/dev');
    await writeRoutesModule(serialized, join(tempDir, '.faapi/dev', 'faapi-routes.js'));
    await generateSchemaFiles(sorted, tempDir, 'src', '.faapi/dev');

    // 启动 dev 应用
    const app: DevApp = await createDevApp({ rootDir: tempDir });
    const reloadSpy = vi.spyOn(app, 'reloadRoutes').mockImplementation(async () => {
      // mock 为空，避免执行完整的 scanRoutes + generateSchemaFiles（已单独测试）
    });
    await app.listen(0);

    // 启动 watcher
    startWatcher({ rootDir: tempDir, appDir: 'src', app });

    // 等 chokidar 初始化
    await new Promise((r) => setTimeout(r, 600));

    // 修改 handler.ts
    writeFileSync(handlerPath, `export function GET() { return { hello: 'changed' }; }\n`, 'utf-8');

    // 轮询等待 reloadRoutes 被调用（最多 5 秒）
    const start = Date.now();
    while (reloadSpy.mock.calls.length === 0 && Date.now() - start < 5000) {
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(reloadSpy.mock.calls.length).toBeGreaterThan(0);

    await app.close();
  }, 15000);

  it('unlink 事件触发 reloadRoutes（不增量编译）', async () => {
    const handlerPath = join(tempDir, 'src', 'api', 'temp', 'handler.ts');
    mkdirSync(join(handlerPath, '..'), { recursive: true });
    writeFileSync(handlerPath, `export function GET() { return { ok: true }; }\n`, 'utf-8');

    await compileDevRoutes({ rootDir: tempDir, appDir: 'src', outDir: '.faapi/dev' });
    await compileConfig({ rootDir: tempDir, outDir: '.faapi/dev' });
    const { routes, wsRoutes } = await scanRoutes(
      tempDir,
      ['src/api/**/*.ts'],
      'src',
      '.faapi/dev',
    );
    const sorted = sortRoutes(routes);
    const serialized = serializeRoutes(sorted, wsRoutes, tempDir, 'src', '.faapi/dev');
    await writeRoutesModule(serialized, join(tempDir, '.faapi/dev', 'faapi-routes.js'));
    await generateSchemaFiles(sorted, tempDir, 'src', '.faapi/dev');

    const app: DevApp = await createDevApp({ rootDir: tempDir });
    const reloadSpy = vi.spyOn(app, 'reloadRoutes').mockImplementation(async () => {});
    await app.listen(0);

    startWatcher({ rootDir: tempDir, appDir: 'src', app });
    await new Promise((r) => setTimeout(r, 600));

    // 删除 handler.ts
    rmSync(handlerPath);

    const start = Date.now();
    while (reloadSpy.mock.calls.length === 0 && Date.now() - start < 5000) {
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(reloadSpy.mock.calls.length).toBeGreaterThan(0);

    await app.close();
  }, 15000);
});
