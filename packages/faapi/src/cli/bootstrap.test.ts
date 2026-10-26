import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProdApp } from './createProdApp';
import { createDevApp } from './createDevApp';
import { compileDevRoutes } from './compileDevRoutes';
import { compileConfig } from './compileConfig';
import { scanRoutes } from '../routers/scanRoutes';
import { sortRoutes } from '../routers/sortRoutes';
import { serializeRoutes, writeRoutesModule } from './generateRoutes';
import { generateSchemaFiles } from './generateSchemaFiles';
import { invalidateMiddlewareCache } from '../middlewares/loadMiddlewares';
import { invalidateProgramCache } from '../ast/createProgram';
import { invalidateSchemaCache } from '../validators/validateInput';

/**
 * src/bootstrap.ts 约定启动文件——loadBootstrap 机制测试
 *
 * 覆盖：prod 形态（dist/bootstrap.js 直载）、dev 形态（src/bootstrap.ts 经
 * ensureCompiled 依赖闭包编译）、可选性（无文件跳过）、抛错语义（reject + 单例清理）、
 * 时序（bootstrap 订阅先于 app:boot 发射）。
 *
 * fixture 不 import '@faapi/faapi'（tmp 项目解析不到发布包）——经 globalThis 上的
 * 同名 Symbol 取 app 单例（与 appSingleton.ts 同款 key），语义等价。
 */

function g(): Record<string, unknown> {
  return globalThis as unknown as Record<string, unknown>;
}

describe('bootstrap（src/bootstrap.ts 约定启动文件）', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(
      tmpdir(),
      `faapi-bootstrap-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tempDir, { recursive: true });
    delete g().__bootEvents;
    delete g().__bootCalls;
    delete g().__flagMarked;
    invalidateMiddlewareCache();
    invalidateProgramCache();
  });

  afterEach(async () => {
    invalidateSchemaCache();
    invalidateMiddlewareCache();
    invalidateProgramCache();
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** 写 faapi.config.ts + handler + 编译产物（createAppBase 前置条件） */
  async function compileArtifacts(): Promise<void> {
    writeFileSync(join(tempDir, 'faapi.config.ts'), `export default {};\n`, 'utf-8');
    const handlerPath = join(tempDir, 'src', 'api', 'hello', 'handler.ts');
    mkdirSync(join(handlerPath, '..'), { recursive: true });
    writeFileSync(handlerPath, `export function GET() { return { hello: 'world' }; }\n`, 'utf-8');

    await compileDevRoutes({ rootDir: tempDir, dist: 'dist' });
    await compileConfig({ rootDir: tempDir, dist: 'dist' });
    const { routes, wsRoutes } = await scanRoutes(tempDir, ['src/api/**/*.ts'], 'dist');
    const sorted = sortRoutes(routes);
    const serialized = serializeRoutes(sorted, wsRoutes, tempDir, 'dist');
    await writeRoutesModule(serialized, join(tempDir, 'dist', 'faapi-routes.js'));
    await generateSchemaFiles(sorted, tempDir, 'dist');
  }

  /** prod 形态 fixture：手写 dist/bootstrap.js（内联 Symbol 取单例订阅） */
  function writeProdBootstrap(bootstrapBody: string): void {
    writeFileSync(
      join(tempDir, 'dist', 'bootstrap.js'),
      `const app = globalThis[Symbol.for('faapi.app.instance')];
if (app) app.on('app:boot', (e) => { (globalThis.__bootEvents ??= []).push(['app:boot', e.server.listening]); });
export default async function () { (globalThis.__bootCalls ??= []).push(1); }
${bootstrapBody ?? ''}`,
      'utf-8',
    );
  }

  it('prod 形态：dist/bootstrap.js 在 listen 前加载执行，订阅先于 app:boot 发射', async () => {
    await compileArtifacts();
    writeProdBootstrap('');

    const app = await createProdApp({ rootDir: tempDir, port: 0 });
    try {
      // bootstrap 执行阶段 app 已创建（订阅成功）且 listen 未发生（无 boot 事件）
      expect(g().__bootCalls as number[]).toEqual([1]);
      expect(g().__bootEvents).toBeUndefined();

      await app.listen();

      const events = (g().__bootEvents as [string, boolean][]) ?? [];
      expect(events).toEqual([['app:boot', false]]);
    } finally {
      await app.close();
    }
  });

  it('可选性：无 bootstrap 产物时 createProdApp 正常启动（零开销跳过）', async () => {
    await compileArtifacts();

    const app = await createProdApp({ rootDir: tempDir, port: 0 });
    try {
      await app.listen();
      expect(app.server).not.toBeNull();
    } finally {
      await app.close();
    }
    expect(g().__bootCalls).toBeUndefined();
  });

  it('抛错语义：bootstrap 执行抛错 → createProdApp reject（不 listen）+ 单例清理（可重建）', async () => {
    await compileArtifacts();
    writeProdBootstrap('throw new Error("bootstrap exploded");');

    await expect(createProdApp({ rootDir: tempDir, port: 0 })).rejects.toThrow(
      'bootstrap exploded',
    );

    // bootstrap 失败的 app 已被框架 close（单例清空）——修复后可立即重建
    rmSync(join(tempDir, 'dist', 'bootstrap.js'));
    const app = await createProdApp({ rootDir: tempDir, port: 0 });
    await app.close();
  });

  it('prod 形态：源码比产物新（改了源码没重新 build）→ 抛错指引 faapi build', async () => {
    await compileArtifacts();
    writeProdBootstrap('');
    // 覆写 src/bootstrap.ts 使其 mtime 新于产物（产物 stale）
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    writeFileSync(
      join(tempDir, 'src', 'bootstrap.ts'),
      `export default async function () { throw new Error('stale source'); }\n`,
      'utf-8',
    );

    await expect(createProdApp({ rootDir: tempDir, port: 0 })).rejects.toThrow(/faapi build/);
  });

  it('dev 形态：src/bootstrap.ts 经 ensureCompiled 依赖闭包编译后执行', async () => {
    await compileArtifacts();
    // 依赖闭包：bootstrap import src 内模块（ensureCompiled 覆盖传递依赖）
    const libPath = join(tempDir, 'src', 'lib');
    mkdirSync(libPath, { recursive: true });
    writeFileSync(
      join(libPath, 'flag.ts'),
      `export function markFlag(): void { (globalThis as { __flagMarked?: boolean }).__flagMarked = true; }\n`,
      'utf-8',
    );
    writeFileSync(
      join(tempDir, 'src', 'bootstrap.ts'),
      `import { markFlag } from './lib/flag';
const app = (globalThis as Record<symbol, { on: (n: string, h: (e: unknown) => void) => void }>)[
  Symbol.for('faapi.app.instance')
];
if (app) app.on('app:boot', () => { const g = globalThis as { __bootEvents?: unknown[][] }; (g.__bootEvents ??= []).push(['app:boot']); });
export default async function () { markFlag(); }
`,
      'utf-8',
    );

    const app = await createDevApp({ rootDir: tempDir, port: 0 });
    try {
      // 闭包编译生效：lib/flag.js 已编译并执行（bootstrap default 调 markFlag）
      expect(g().__flagMarked).toBe(true);
      expect(g().__bootEvents).toBeUndefined();

      await app.listen();
      expect(g().__bootEvents).toEqual([['app:boot']]);
    } finally {
      await app.close();
    }
  });

  it('dev 形态：无 src/bootstrap.ts 时跳过', async () => {
    await compileArtifacts();

    const app = await createDevApp({ rootDir: tempDir, port: 0 });
    try {
      await app.listen();
      expect(g().__bootCalls).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
