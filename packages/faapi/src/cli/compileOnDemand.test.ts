import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDevApp } from './createDevApp';
import { compileConfig } from './compileConfig';
import { scanRoutes } from '../router/scanRoutes';
import { sortRoutes } from '../router/sortRoutes';
import { serializeRoutes, writeRoutesModule } from './generateRoutes';
import {
  setDevOnDemandEnabled,
  setDevDist,
  clearCompiledFiles,
  clearGeneratedSchemas,
  ensureCompiled,
  ensureSchemaGenerated,
  prodPathToSourcePath,
} from './compileOnDemand';
import { invalidateMiddlewareCache } from '../middleware/loadMiddlewares';
import { invalidateProgramCache } from '../ast/createProgram';
import { invalidateSchemaCache } from '../validator/validateInput';

/**
 * 按需编译（Vite 风格）测试
 *
 * 验证：
 * 1. dev 启动时不全量编译 handler.js（仅编译 config + 路由清单）
 * 2. 首次请求触发按需编译 → handler.js 生成 → 请求成功
 * 3. ensureCompiled 单文件编译的幂等性
 * 4. prodPathToSourcePath 反推源码路径
 * 5. invalidateCompiledFile 清除缓存后重新编译
 */
describe('按需编译（Vite 风格）', () => {
  let tempDir: string;
  let savedDist: string | undefined;

  beforeEach(() => {
    tempDir = join(tmpdir(), `faapi-ondemand-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    savedDist = process.env.FAAPI_DIST;
    process.env.FAAPI_DIST = '.faapi';
    setDevOnDemandEnabled(true);
    setDevDist('.faapi');
    invalidateMiddlewareCache();
    invalidateProgramCache();
    clearCompiledFiles();
    clearGeneratedSchemas();
  });

  afterEach(async () => {
    if (savedDist === undefined) delete process.env.FAAPI_DIST;
    else process.env.FAAPI_DIST = savedDist;
    setDevOnDemandEnabled(false);
    setDevDist('');
    invalidateSchemaCache();
    invalidateMiddlewareCache();
    invalidateProgramCache();
    clearCompiledFiles();
    clearGeneratedSchemas();
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

  /**
   * 仅生成路由清单和 config（不编译 handler.js），模拟按需编译模式下的 dev 启动
   */
  async function generateManifestOnly() {
    await compileConfig({ rootDir: tempDir, dist: '.faapi' });
    const { routes, wsRoutes } = await scanRoutes(tempDir, ['src/api/**/*.ts'], '.faapi');
    const sorted = sortRoutes(routes);
    const serialized = serializeRoutes(sorted, wsRoutes, tempDir, '.faapi');
    await writeRoutesModule(serialized, join(tempDir, '.faapi', 'faapi-routes.js'));
  }

  it('dev 启动时不编译 handler.js（.faapi 下不存在 handler.js）', async () => {
    writeHandler();
    await generateManifestOnly();

    // 验证 .faapi/api/hello/handler.js 不存在（按需编译模式未编译）
    const handlerJsPath = join(tempDir, '.faapi', 'api', 'hello', 'handler.js');
    expect(existsSync(handlerJsPath)).toBe(false);
  });

  it('ensureCompiled 首次调用编译源码，再次调用跳过', async () => {
    writeHandler();
    await generateManifestOnly();

    const sourcePath = join(tempDir, 'src', 'api', 'hello', 'handler.ts');
    const handlerJsPath = join(tempDir, '.faapi', 'api', 'hello', 'handler.js');

    // 首次调用：触发编译
    const compiled1 = await ensureCompiled(sourcePath, tempDir, '.faapi');
    expect(compiled1).toBe(true);
    expect(existsSync(handlerJsPath)).toBe(true);

    // 再次调用：跳过（已编译标记）
    const compiled2 = await ensureCompiled(sourcePath, tempDir, '.faapi');
    expect(compiled2).toBe(false);
  });

  it('clearCompiledFiles 清除缓存后，源码变化时重新编译', async () => {
    writeHandler();
    await generateManifestOnly();

    const sourcePath = join(tempDir, 'src', 'api', 'hello', 'handler.ts');
    await ensureCompiled(sourcePath, tempDir, '.faapi');

    // 模拟源码变化：重写文件 + 显式设置未来 mtime（CI 文件系统 mtime 精度可能较粗，
    // 重写文件后 mtime 可能未前进 → isProductFresh 误判产物最新 → 跳过重编译）
    writeHandler();
    const futureTime = Date.now() / 1000 + 10;
    utimesSync(sourcePath, futureTime, futureTime);
    clearCompiledFiles();

    // 再次调用：源码 mtime > 产物 mtime → 重新编译
    const compiled = await ensureCompiled(sourcePath, tempDir, '.faapi');
    expect(compiled).toBe(true);
  });

  it('mtime 缓存：产物已最新时跳过编译', async () => {
    writeHandler();
    await generateManifestOnly();

    const sourcePath = join(tempDir, 'src', 'api', 'hello', 'handler.ts');
    // 首次编译
    await ensureCompiled(sourcePath, tempDir, '.faapi');

    // 清除内存缓存但不动文件（产物已最新）
    clearCompiledFiles();

    // 再次调用：产物 mtime ≥ 源码 mtime → 跳过编译
    const compiled = await ensureCompiled(sourcePath, tempDir, '.faapi');
    expect(compiled).toBe(false);
  });

  it('prodPathToSourcePath 反推源码路径', () => {
    writeHandler(); // 写入源码 .ts，确保 prodPathToSourcePath 能找到 .ts
    const prodPath = join(tempDir, '.faapi', 'api', 'hello', 'handler.js');
    const sourcePath = prodPathToSourcePath(prodPath, tempDir, '.faapi');
    expect(sourcePath).toBe(join(tempDir, 'src', 'api', 'hello', 'handler.ts'));
  });

  it('ensureCompiled 源文件不存在时返回 false', async () => {
    const nonexistentPath = join(tempDir, 'src', 'api', 'nonexistent', 'handler.ts');
    const compiled = await ensureCompiled(nonexistentPath, tempDir, '.faapi');
    expect(compiled).toBe(false);
  });

  it('ensureSchemaGenerated 首次调用生成 zod.js，再次调用跳过', async () => {
    writeHandler();
    await generateManifestOnly();

    // 扫描路由 + 序列化（模拟 hydration 后的状态：filePath 为产物路径）
    const { routes } = await scanRoutes(tempDir, ['src/api/**/*.ts'], '.faapi');
    const { serializeRoutes } = await import('./generateRoutes');
    const serialized = serializeRoutes(routes, [], tempDir, '.faapi');
    // hydrated routes 的 filePath 是产物路径（如 .faapi/api/hello/handler.js）
    const routeFilePath = serialized.routes[0].filePath;
    const schemaPath = join(tempDir, '.faapi', 'api', 'hello', 'zod.js');

    expect(existsSync(schemaPath)).toBe(false);

    // 首次调用：生成 zod.js
    const generated1 = await ensureSchemaGenerated(
      schemaPath,
      routeFilePath,
      serialized.routes as unknown as import('../router/routeTypes').RouteManifest,
      tempDir,
      '.faapi',
    );
    expect(generated1).toBe(true);
    expect(existsSync(schemaPath)).toBe(true);

    // 再次调用：跳过（内存缓存命中）
    const generated2 = await ensureSchemaGenerated(
      schemaPath,
      routeFilePath,
      serialized.routes as unknown as import('../router/routeTypes').RouteManifest,
      tempDir,
      '.faapi',
    );
    expect(generated2).toBe(false);
  });

  it('ensureSchemaGenerated mtime 缓存：zod.js 已最新时跳过', async () => {
    writeHandler();
    await generateManifestOnly();

    const { routes } = await scanRoutes(tempDir, ['src/api/**/*.ts'], '.faapi');
    const { serializeRoutes } = await import('./generateRoutes');
    const serialized = serializeRoutes(routes, [], tempDir, '.faapi');
    const routeFilePath = serialized.routes[0].filePath;
    const schemaPath = join(tempDir, '.faapi', 'api', 'hello', 'zod.js');

    // 首次生成
    await ensureSchemaGenerated(
      schemaPath,
      routeFilePath,
      serialized.routes as unknown as import('../router/routeTypes').RouteManifest,
      tempDir,
      '.faapi',
    );

    // 清除内存缓存（模拟 reloadRoutes 后）
    clearGeneratedSchemas();

    // 再次调用：zod.js 存在且 mtime ≥ 源码 mtime → 跳过
    const generated = await ensureSchemaGenerated(
      schemaPath,
      routeFilePath,
      serialized.routes as unknown as import('../router/routeTypes').RouteManifest,
      tempDir,
      '.faapi',
    );
    expect(generated).toBe(false);
  });

  it('完整请求链路：首次请求触发按需编译 + schema 生成 → 响应成功', async () => {
    writeHandler();
    await generateManifestOnly();

    const handlerJsPath = join(tempDir, '.faapi', 'api', 'hello', 'handler.js');
    const zodJsPath = join(tempDir, '.faapi', 'api', 'hello', 'zod.js');
    expect(existsSync(handlerJsPath)).toBe(false);
    expect(existsSync(zodJsPath)).toBe(false);

    // 启动 dev 应用
    const app = await createDevApp({ rootDir: tempDir });
    const server = await app.listen(0);
    const port = (server.address() as { port: number }).port;
    const baseUrl = `http://localhost:${port}`;

    try {
      // 首次请求：handler.js 不存在 → 按需编译 → zod.js 不存在 → 按需生成 → 响应成功
      const res = await fetch(`${baseUrl}/api/hello`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ data: { hello: 'world' } });

      // 验证按需编译 + schema 生成已触发
      expect(existsSync(handlerJsPath)).toBe(true);
      expect(existsSync(zodJsPath)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('完整请求链路：带类型声明的 handler 按需生成 schema → 校验通过', async () => {
    // 带 Query 类型声明的 handler（number 字段会做 coerce 校验）
    writeHandler(
      'api/user/handler.ts',
      [
        'export interface Query { page: number; pageSize: number; }',
        'export function GET(query: Query) { return { page: query.page, pageSize: query.pageSize }; }',
      ].join('\n'),
    );
    await generateManifestOnly();

    const app = await createDevApp({ rootDir: tempDir });
    const server = await app.listen(0);
    const port = (server.address() as { port: number }).port;
    const baseUrl = `http://localhost:${port}`;

    try {
      // 首次请求：按需编译 + 按需生成 schema → query 参数校验通过
      // 注：query 注入值为原始 string（框架现有行为），zod 校验确认可 coerce 为 number
      const res = await fetch(`${baseUrl}/api/user?page=1&pageSize=10`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ data: { page: '1', pageSize: '10' } });

      // 无效 query（page=abc 无法 coerce 为 number）→ 校验失败 → 422
      const res2 = await fetch(`${baseUrl}/api/user?page=abc&pageSize=10`);
      expect(res2.status).toBe(422);
    } finally {
      await app.close();
    }
  });

  it('ensureCompiled 编译失败时抛错（不静默吞错）', async () => {
    writeHandler('api/broken/handler.ts', 'export function GET( { ; ; ;  invalid syntax');
    await generateManifestOnly();

    const sourcePath = join(tempDir, 'src', 'api', 'broken', 'handler.ts');
    await expect(ensureCompiled(sourcePath, tempDir, '.faapi')).rejects.toThrow(
      /Build failed|Transform failed|Unexpected|ERROR/i,
    );
  });

  it('ensureSchemaGenerated 生成失败时抛错（不静默吞错）', async () => {
    writeHandler(
      'api/bad-type/handler.ts',
      [
        'export interface Query { page: any; }',
        'export function GET(query: Query) { return { page: query.page }; }',
      ].join('\n'),
    );
    await generateManifestOnly();

    const { routes } = await scanRoutes(tempDir, ['src/api/**/*.ts'], '.faapi');
    const { serializeRoutes } = await import('./generateRoutes');
    const serialized = serializeRoutes(routes, [], tempDir, '.faapi');
    const routeFilePath = serialized.routes[0].filePath;
    const schemaPath = join(tempDir, '.faapi', 'api', 'bad-type', 'zod.js');

    await expect(
      ensureSchemaGenerated(
        schemaPath,
        routeFilePath,
        serialized.routes as unknown as import('../router/routeTypes').RouteManifest,
        tempDir,
        '.faapi',
      ),
    ).rejects.toThrow(/SchemaExtractionError|any/i);
  });

  it('完整请求链路：handler 语法错误 → 500 响应（编译错误被传递）', async () => {
    writeHandler('api/broken/handler.ts', 'export function GET( { ; ; ;  invalid syntax');
    await generateManifestOnly();

    const app = await createDevApp({ rootDir: tempDir });
    const server = await app.listen(0);
    const port = (server.address() as { port: number }).port;
    const baseUrl = `http://localhost:${port}`;

    try {
      const res = await fetch(`${baseUrl}/api/broken`);
      expect(res.status).toBe(500);
    } finally {
      await app.close();
    }
  });
});
