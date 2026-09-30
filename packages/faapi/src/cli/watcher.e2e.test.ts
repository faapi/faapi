import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
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
import { copyResources } from './copyResources';
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
  let savedDist: string | undefined;

  beforeEach(() => {
    tempDir = join(tmpdir(), `faapi-watcher-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    savedDist = process.env.FAAPI_DIST;
    process.env.FAAPI_DIST = '.faapi';
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

  it('handler.ts 变化触发 reloadRoutes', async () => {
    const handlerPath = join(tempDir, 'src', 'api', 'hello', 'handler.ts');
    mkdirSync(join(handlerPath, '..'), { recursive: true });
    writeFileSync(handlerPath, `export function GET() { return { hello: 'world' }; }\n`, 'utf-8');

    // 编译产物三元组
    await compileDevRoutes({ rootDir: tempDir, dist: '.faapi' });
    await compileConfig({ rootDir: tempDir, dist: '.faapi' });
    const { routes, wsRoutes } = await scanRoutes(tempDir, ['src/api/**/*.ts'], '.faapi');
    const sorted = sortRoutes(routes);
    const serialized = serializeRoutes(sorted, wsRoutes, tempDir, '.faapi');
    await writeRoutesModule(serialized, join(tempDir, '.faapi', 'faapi-routes.js'));
    await generateSchemaFiles(sorted, tempDir, '.faapi');

    // 启动 dev 应用
    const app: DevApp = await createDevApp({ rootDir: tempDir });
    const reloadSpy = vi.spyOn(app, 'reloadRoutes').mockImplementation(async () => {
      // mock 为空，避免执行完整的 scanRoutes + generateSchemaFiles（已单独测试）
    });
    await app.listen(0);

    // 启动 watcher
    startWatcher({ rootDir: tempDir, app, devDist: '.faapi' });

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

    await compileDevRoutes({ rootDir: tempDir, dist: '.faapi' });
    await compileConfig({ rootDir: tempDir, dist: '.faapi' });
    const { routes, wsRoutes } = await scanRoutes(tempDir, ['src/api/**/*.ts'], '.faapi');
    const sorted = sortRoutes(routes);
    const serialized = serializeRoutes(sorted, wsRoutes, tempDir, '.faapi');
    await writeRoutesModule(serialized, join(tempDir, '.faapi', 'faapi-routes.js'));
    await generateSchemaFiles(sorted, tempDir, '.faapi');

    const app: DevApp = await createDevApp({ rootDir: tempDir });
    const reloadSpy = vi.spyOn(app, 'reloadRoutes').mockImplementation(async () => {});
    await app.listen(0);

    startWatcher({ rootDir: tempDir, app, devDist: '.faapi' });
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

  it('src/resources 下非 .ts 文件修改增量复制到产物，不触发 reload', async () => {
    const handlerPath = join(tempDir, 'src', 'api', 'hello', 'handler.ts');
    mkdirSync(join(handlerPath, '..'), { recursive: true });
    writeFileSync(handlerPath, `export function GET() { return { hello: 'world' }; }\n`, 'utf-8');
    // 资源文件（非 .ts——此前 watcher 会忽略此类文件）
    const resourcePath = join(tempDir, 'src', 'resources', 'greet.txt');
    mkdirSync(join(resourcePath, '..'), { recursive: true });
    writeFileSync(resourcePath, 'v1', 'utf-8');

    await compileDevRoutes({ rootDir: tempDir, dist: '.faapi' });
    await compileConfig({ rootDir: tempDir, dist: '.faapi' });
    const { routes, wsRoutes } = await scanRoutes(tempDir, ['src/api/**/*.ts'], '.faapi');
    const sorted = sortRoutes(routes);
    const serialized = serializeRoutes(sorted, wsRoutes, tempDir, '.faapi');
    await writeRoutesModule(serialized, join(tempDir, '.faapi', 'faapi-routes.js'));
    await generateSchemaFiles(sorted, tempDir, '.faapi');
    // 模拟 devCommand 启动期的资源镜像复制
    await copyResources(tempDir, '.faapi');

    const app: DevApp = await createDevApp({ rootDir: tempDir });
    const reloadRoutesSpy = vi.spyOn(app, 'reloadRoutes').mockImplementation(async () => {});
    await app.listen(0);

    startWatcher({ rootDir: tempDir, app, devDist: '.faapi' });
    await new Promise((r) => setTimeout(r, 600));

    // 修改资源文件（非 .ts 扩展名）
    writeFileSync(resourcePath, 'v2', 'utf-8');

    // 轮询等待产物同步（最多 5 秒）
    const outPath = join(tempDir, '.faapi', 'resources', 'greet.txt');
    const start = Date.now();
    while (
      (!existsSync(outPath) || readFileSync(outPath, 'utf-8') !== 'v2') &&
      Date.now() - start < 5000
    ) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(readFileSync(outPath, 'utf-8')).toBe('v2');

    // 留出 debounce（100ms）+ 编译窗口，确认 resources 事件没有误入编译调度器
    await new Promise((r) => setTimeout(r, 500));
    expect(reloadRoutesSpy.mock.calls.length).toBe(0);

    await app.close();
  }, 15000);

  it('src/resources 下文件删除同步删除产物文件', async () => {
    const handlerPath = join(tempDir, 'src', 'api', 'hello', 'handler.ts');
    mkdirSync(join(handlerPath, '..'), { recursive: true });
    writeFileSync(handlerPath, `export function GET() { return { hello: 'world' }; }\n`, 'utf-8');
    const resourcePath = join(tempDir, 'src', 'resources', 'temp.txt');
    mkdirSync(join(resourcePath, '..'), { recursive: true });
    writeFileSync(resourcePath, 'temp', 'utf-8');

    await compileDevRoutes({ rootDir: tempDir, dist: '.faapi' });
    await compileConfig({ rootDir: tempDir, dist: '.faapi' });
    const { routes, wsRoutes } = await scanRoutes(tempDir, ['src/api/**/*.ts'], '.faapi');
    const sorted = sortRoutes(routes);
    const serialized = serializeRoutes(sorted, wsRoutes, tempDir, '.faapi');
    await writeRoutesModule(serialized, join(tempDir, '.faapi', 'faapi-routes.js'));
    await generateSchemaFiles(sorted, tempDir, '.faapi');
    await copyResources(tempDir, '.faapi');

    const app: DevApp = await createDevApp({ rootDir: tempDir });
    vi.spyOn(app, 'reloadRoutes').mockImplementation(async () => {});
    await app.listen(0);

    startWatcher({ rootDir: tempDir, app, devDist: '.faapi' });
    await new Promise((r) => setTimeout(r, 600));

    // 删除源资源文件
    rmSync(resourcePath);

    // 轮询等待产物文件被删除（最多 5 秒）
    const outPath = join(tempDir, '.faapi', 'resources', 'temp.txt');
    const start = Date.now();
    while (existsSync(outPath) && Date.now() - start < 5000) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(existsSync(outPath)).toBe(false);

    await app.close();
  }, 15000);
});
