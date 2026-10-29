import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync, utimesSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { createDevApp } from './createDevApp';
import { compileConfig } from './compileConfig';
import { scanRoutes } from '../routers/scanRoutes';
import { sortRoutes } from '../routers/sortRoutes';
import { serializeRoutes, writeRoutesModule } from './generateRoutes';
import {
  setDevOnDemandEnabled,
  setDevDist,
  clearCompiledFiles,
  clearGeneratedSchemas,
  ensureCompiled,
  ensureSchemaGenerated,
  prodPathToSourcePath,
  _resetDevOnDemandState,
} from './compileOnDemand';
import { invalidateMiddlewareCache } from '../middlewares/loadMiddlewares';
import { invalidateProgramCache } from '../ast/createProgram';
import { invalidateSchemaCache } from '../validators/validateInput';

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
      serialized.routes as unknown as import('../routers/routeTypes').RouteManifest,
      tempDir,
      '.faapi',
    );
    expect(generated1).toBe(true);
    expect(existsSync(schemaPath)).toBe(true);

    // 再次调用：跳过（内存缓存命中）
    const generated2 = await ensureSchemaGenerated(
      schemaPath,
      routeFilePath,
      serialized.routes as unknown as import('../routers/routeTypes').RouteManifest,
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
      serialized.routes as unknown as import('../routers/routeTypes').RouteManifest,
      tempDir,
      '.faapi',
    );

    // 清除内存缓存（模拟 reloadRoutes 后）
    clearGeneratedSchemas();

    // 再次调用：zod.js 存在且 mtime ≥ 源码 mtime → 跳过
    const generated = await ensureSchemaGenerated(
      schemaPath,
      routeFilePath,
      serialized.routes as unknown as import('../routers/routeTypes').RouteManifest,
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

  it('完整请求链路：handler 引用共享模块 + 目录中间件（依赖闭包按需编译）', async () => {
    // 共享模块：handler 与中间件都引用（闭包需覆盖两层传递依赖）
    mkdirSync(join(tempDir, 'src', 'lib'), { recursive: true });
    writeFileSync(
      join(tempDir, 'src', 'lib', 'users.ts'),
      `import { prefix } from './prefix';\nexport function userName(id: number) { return prefix + id; }\n`,
      'utf-8',
    );
    writeFileSync(
      join(tempDir, 'src', 'lib', 'prefix.ts'),
      `export const prefix = 'u';\n`,
      'utf-8',
    );

    // handler：引用共享模块（修复前：.faapi/lib/users.js 无产物，首次请求 ERR_MODULE_NOT_FOUND）
    writeHandler(
      'api/users/handler.ts',
      [
        `import { userName } from '../../lib/users';`,
        `export interface Query { id: number; }`,
        `export function GET(query: Query) { return { name: userName(query.id) }; }`,
      ].join('\n'),
    );

    // 目录中间件：引用共享模块（修复前：middlewares.js 无产物，首次请求 ERR_MODULE_NOT_FOUND）
    writeFileSync(
      join(tempDir, 'src', 'api', 'users', 'middlewares.ts'),
      [
        `import type { FaapiMiddleware } from '../../index';`,
        `import { prefix } from '../../lib/prefix';`,
        `const tag: FaapiMiddleware = async (ctx, next) => { ctx.setHeader('x-tag', prefix); await next(); };`,
        `export default [tag];`,
      ].join('\n'),
      'utf-8',
    );

    await generateManifestOnly();

    // dev 启动：只编译 config + 路由清单，handler/中间件/共享模块产物都不存在
    expect(existsSync(join(tempDir, '.faapi', 'api', 'users', 'handler.js'))).toBe(false);
    expect(existsSync(join(tempDir, '.faapi', 'lib', 'users.js'))).toBe(false);
    expect(existsSync(join(tempDir, '.faapi', 'api', 'users', 'middlewares.js'))).toBe(false);

    const app = await createDevApp({ rootDir: tempDir });
    const server = await app.listen(0);
    const port = (server.address() as { port: number }).port;
    const baseUrl = `http://localhost:${port}`;

    try {
      // 首次请求：闭包编译（handler + lib/users + lib/prefix + middlewares）→ 响应成功
      const res = await fetch(`${baseUrl}/api/users?id=1`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ data: { name: 'u1' } });
      // 目录中间件生效（引用共享模块的中间件正常执行）
      expect(res.headers.get('x-tag')).toBe('u');

      // 闭包产物已生成
      expect(existsSync(join(tempDir, '.faapi', 'api', 'users', 'handler.js'))).toBe(true);
      expect(existsSync(join(tempDir, '.faapi', 'lib', 'users.js'))).toBe(true);
      expect(existsSync(join(tempDir, '.faapi', 'lib', 'prefix.js'))).toBe(true);
      expect(existsSync(join(tempDir, '.faapi', 'api', 'users', 'middlewares.js'))).toBe(true);
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
      // query 注入值为 schema 解析后的声明类型（number），不再是原始 string
      const res = await fetch(`${baseUrl}/api/user?page=1&pageSize=10`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ data: { page: 1, pageSize: 10 } });

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
        serialized.routes as unknown as import('../routers/routeTypes').RouteManifest,
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

  it('ensureCompiled mutex: 同一文件并发请求只触发一次编译', async () => {
    writeHandler();
    await generateManifestOnly();

    const sourcePath = join(tempDir, 'src', 'api', 'hello', 'handler.ts');
    const handlerJsPath = join(tempDir, '.faapi', 'api', 'hello', 'handler.js');

    // 并发调 ensureCompiled 两次,验证 mutex 只让其中一个触发编译
    const [r1, r2] = await Promise.all([
      ensureCompiled(sourcePath, tempDir, '.faapi'),
      ensureCompiled(sourcePath, tempDir, '.faapi'),
    ]);

    // 期望: 一个 true(触发编译) + 一个 false(mutex 命中,等待后返回)
    const trueCount = [r1, r2].filter((r) => r === true).length;
    const falseCount = [r1, r2].filter((r) => r === false).length;
    expect(trueCount).toBe(1);
    expect(falseCount).toBe(1);
    // handler.js 已生成
    expect(existsSync(handlerJsPath)).toBe(true);
  });

  it('ensureCompiled mutex: 编译失败时并发等待方收到同一真实错误（不吞错）', async () => {
    // 回归：此前等待方 await in-flight 后 catch 吞错返回 false，调用方接着去 import
    // 不存在的产物，报误导性的 ERR_MODULE_NOT_FOUND 掩盖真实编译错误。
    // 现在等待方原样传播首个触发方的编译错误
    writeHandler('api/broken/handler.ts', 'export function GET( { ; ; ;  invalid syntax');
    await generateManifestOnly();

    const sourcePath = join(tempDir, 'src', 'api', 'broken', 'handler.ts');

    const [r1, r2] = await Promise.allSettled([
      ensureCompiled(sourcePath, tempDir, '.faapi'),
      ensureCompiled(sourcePath, tempDir, '.faapi'),
    ]);

    expect(r1.status).toBe('rejected');
    expect(r2.status).toBe('rejected');
    // 两个请求拿到的是同一类真实编译错误（esbuild），而非模块缺失
    const reason1 = (r1 as PromiseRejectedResult).reason as Error;
    const reason2 = (r2 as PromiseRejectedResult).reason as Error;
    expect(String(reason1.message ?? reason1)).toMatch(/invalid syntax|Build failed|ERROR/i);
    expect(String(reason2.message ?? reason2)).toMatch(/invalid syntax|Build failed|ERROR/i);
  });

  it('ensureSchemaGenerated mutex: 生成失败时并发等待方收到同一真实错误', async () => {
    // 回归：与 ensureCompiled 同语义——等待方原样传播首个触发方的生成错误
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

    const [r1, r2] = await Promise.allSettled([
      ensureSchemaGenerated(
        schemaPath,
        routeFilePath,
        serialized.routes as unknown as import('../routers/routeTypes').RouteManifest,
        tempDir,
        '.faapi',
      ),
      ensureSchemaGenerated(
        schemaPath,
        routeFilePath,
        serialized.routes as unknown as import('../routers/routeTypes').RouteManifest,
        tempDir,
        '.faapi',
      ),
    ]);
    expect(r1.status).toBe('rejected');
    expect(r2.status).toBe('rejected');
    const reason1 = String((r1 as PromiseRejectedResult).reason);
    expect(reason1).toMatch(/SchemaExtractionError|any/i);
  });

  it('_resetDevOnDemandState 清空所有状态', async () => {
    writeHandler();
    await generateManifestOnly();

    const sourcePath = join(tempDir, 'src', 'api', 'hello', 'handler.ts');
    // 首次编译
    await ensureCompiled(sourcePath, tempDir, '.faapi');

    // 重置状态后,即使产物已存在,内存缓存被清空
    _resetDevOnDemandState();
    // 重新启用 dev on demand(被 reset 清掉了)
    setDevOnDemandEnabled(true);
    setDevDist('.faapi');

    // 再次调用: 产物 mtime ≥ 源码 mtime → mtime 复用,加入 Set,return false
    // 这验证了 reset 把 compiledFiles 清空了(否则会直接 return false 而不检查 mtime)
    const compiled = await ensureCompiled(sourcePath, tempDir, '.faapi');
    expect(compiled).toBe(false); // mtime fresh
  });

  it('dev 停机期间传递依赖变更：入口产物 fresh 也重编译 stale 闭包（新旧混编回归）', async () => {
    // 复现业务反馈（TODO-faapi-bugs）：dev server 停机期间源码重构——b.ts 删除
    // markChatInput 导出、a.ts 同步去引用（等价 lib/novel-memory.ts 与
    // lib/agent-app-events.ts），bootstrap.ts 本身未改。
    // b 在 config 依赖闭包内——重启时 compileConfig 必重编译 config 闭包（新进程
    // 缓存为空），b.js 为新源码产物；a 只在 bootstrap 依赖闭包内——修复前
    // ensureCompiled 入口产物 fresh 提前返回、闭包逐文件检查被跳过，a.js 保持
    // 旧产物：旧 a.js `import { markChatInput } from './b'` 撞上新 b.js →
    // ESM named export 缺失，启动报与根因距离很远的链接错误。
    const libDir = join(tempDir, 'src', 'lib');
    mkdirSync(libDir, { recursive: true });
    const bSource = join(libDir, 'b.ts');
    const aSource = join(libDir, 'a.ts');
    const bootstrapSource = join(tempDir, 'src', 'bootstrap.ts');
    writeFileSync(
      bSource,
      `export const bVersion = 'v1';\nexport function markChatInput() { return 'marked'; }\n`,
      'utf-8',
    );
    writeFileSync(
      aSource,
      `import { markChatInput } from './b';\nexport function runA(): string { return markChatInput(); }\n`,
      'utf-8',
    );
    writeFileSync(
      bootstrapSource,
      `import { runA } from './lib/a';\nexport default function bootstrap(): string { return runA(); }\n`,
      'utf-8',
    );
    writeFileSync(
      join(tempDir, 'faapi.config.ts'),
      `import { bVersion } from './src/lib/b';\nexport default { tag: bVersion };\n`,
      'utf-8',
    );

    // 第一会话：config 闭包含 b；bootstrap 加载链闭包编译 a、b
    await generateManifestOnly();
    await ensureCompiled(bootstrapSource, tempDir, '.faapi');
    const aProduct = join(tempDir, '.faapi', 'lib', 'a.js');
    const bProduct = join(tempDir, '.faapi', 'lib', 'b.js');
    expect(existsSync(aProduct)).toBe(true);
    expect(existsSync(bProduct)).toBe(true);

    // 停机重构：b 删导出、a 去引用，bootstrap.ts 不动。
    // mtime 显式后移（CI 文件系统 mtime 粒度可能较粗，禁止依赖自然 mtime 顺序）
    const futureTime = Date.now() / 1000 + 10;
    writeFileSync(bSource, `export const bVersion = 'v2';\n`, 'utf-8');
    writeFileSync(aSource, `export function runA(): string { return 'refactored'; }\n`, 'utf-8');
    utimesSync(aSource, futureTime, futureTime);
    utimesSync(bSource, futureTime, futureTime);

    // 第二会话：重启 dev（新进程语义——内存缓存清空；compileConfig 进程内缓存
    // 同样为空 → config 闭包重编译，b.js 更新为新源码产物）
    _resetDevOnDemandState();
    setDevOnDemandEnabled(true);
    setDevDist('.faapi');
    await generateManifestOnly();
    // 前置条件确认：b.js 已被 config 闭包重编译为不含 markChatInput 的新产物
    expect(readFileSync(bProduct, 'utf-8')).not.toContain('markChatInput');

    // bootstrap.ts 未改 → bootstrap.js 产物 fresh；修复后仍走闭包逐文件新鲜度
    // 检查，发现 a.js stale → 重编译，import 链路一致
    const compiled = await ensureCompiled(bootstrapSource, tempDir, '.faapi');
    expect(compiled).toBe(true);

    const mod = (await import(pathToFileURL(join(tempDir, '.faapi', 'bootstrap.js')).href)) as {
      default: () => string;
    };
    expect(await mod.default()).toBe('refactored');
  });

  it('ensureSchemaGenerated 闭包感知：跨文件类型变更后重新生成（handler 未改）', async () => {
    // zod.js 内容内联跨文件类型（checker 解析完整 RuntimeType），handler 未改
    // 不足以证明 schema 最新——依赖类型在 dev 停机期间被改、重启后仅凭 handler
    // mtime 判 fresh 会用过期 schema 校验（校验按旧类型执行，静默错）
    const libDir = join(tempDir, 'src', 'lib');
    mkdirSync(libDir, { recursive: true });
    const typesSource = join(libDir, 'types.ts');
    const handlerSource = join(tempDir, 'src', 'api', 'user', 'handler.ts');
    writeFileSync(typesSource, `export interface UserQuery { page: number; }\n`, 'utf-8');
    writeHandler(
      'api/user/handler.ts',
      [
        `import type { UserQuery } from '../../lib/types';`,
        `export type Query = UserQuery;`,
        `export function GET(query: Query) { return { page: query.page }; }`,
      ].join('\n'),
    );
    await generateManifestOnly();

    const { routes } = await scanRoutes(tempDir, ['src/api/**/*.ts'], '.faapi');
    const { serializeRoutes } = await import('./generateRoutes');
    const serialized = serializeRoutes(routes, [], tempDir, '.faapi');
    const routeFilePath = serialized.routes[0].filePath;
    const schemaPath = join(tempDir, '.faapi', 'api', 'user', 'zod.js');

    // 第一会话：编译 handler + 生成 zod
    await ensureCompiled(handlerSource, tempDir, '.faapi');
    const generated1 = await ensureSchemaGenerated(
      schemaPath,
      routeFilePath,
      serialized.routes as unknown as import('../routers/routeTypes').RouteManifest,
      tempDir,
      '.faapi',
    );
    expect(generated1).toBe(true);
    const zodBefore = readFileSync(schemaPath, 'utf-8');

    // 停机重构：类型从 number 改为 string（coerce 行为差异可观测），handler 不动
    const futureTime = Date.now() / 1000 + 10;
    writeFileSync(typesSource, `export interface UserQuery { page: string; }\n`, 'utf-8');
    utimesSync(typesSource, futureTime, futureTime);

    // 新进程语义（真实重启下 Program/内存缓存天然为空；存活进程由 watcher
    // reloadRoutes 的 invalidateProgramCache 承担同一失效）
    _resetDevOnDemandState();
    setDevOnDemandEnabled(true);
    setDevDist('.faapi');
    invalidateProgramCache();

    // 修复后：闭包内 types.ts mtime 晚于 zod.js → 重新生成（修复前 false：仅凭
    // handler mtime 判 fresh 提前跳过，schema 按旧类型执行）
    const generated2 = await ensureSchemaGenerated(
      schemaPath,
      routeFilePath,
      serialized.routes as unknown as import('../routers/routeTypes').RouteManifest,
      tempDir,
      '.faapi',
    );
    expect(generated2).toBe(true);
    expect(readFileSync(schemaPath, 'utf-8')).not.toBe(zodBefore);
  });
});
