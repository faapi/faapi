import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compileConfig } from './compileConfig';
import { compileDevRoutes } from './compileDevRoutes';
import { importWithCacheBust } from '../utils/importWithCacheBust';

/**
 * compileConfig 测试：build 时编译配置文件
 *
 * 覆盖：
 * - 无配置文件：不生成产物
 * - 仅基础配置：编译并输出 dist/faapi-config.js
 * - .ts / .js 配置文件
 * - 配置文件相对 import 保留为 external（不 inline，运行时从 dist 加载）
 * - 配置文件 bare import 保留 external
 * - 函数型配置保留（middlewares/extendContext 等）
 * - config import 项目模块，instanceof 跨 config/routes 生效
 *
 * 多环境配置通过 .env 文件实现（见 loadEnv.test.ts），不再使用 faapi.config.{env}.ts。
 */
describe('compileConfig', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(
      tmpdir(),
      `faapi-compile-config-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** 写文件到 tempDir 下指定相对路径 */
  function writeFile(relPath: string, content: string) {
    const abs = join(tempDir, relPath);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content, 'utf-8');
  }

  /** import 产物并返回 default 导出 */
  async function importProduct<T = unknown>(): Promise<T> {
    const productPath = join(tempDir, 'dist', 'faapi-config.js');
    const mod = (await importWithCacheBust(productPath)) as { default?: T };
    return mod.default as T;
  }

  it('无配置文件时不生成产物', async () => {
    const result = await compileConfig({ rootDir: tempDir, dist: 'dist' });
    expect(result.generated).toBe(false);
    expect(existsSync(join(tempDir, 'dist', 'faapi-config.js'))).toBe(false);
  });

  it('仅基础配置 .ts：编译并输出 dist/faapi-config.js', async () => {
    writeFile(
      'faapi.config.ts',
      `export default { port: 3000, db: { host: 'localhost', port: 5432 } };\n`,
    );

    const result = await compileConfig({ rootDir: tempDir, dist: 'dist' });
    expect(result.generated).toBe(true);
    expect(existsSync(join(tempDir, 'dist', 'faapi-config.js'))).toBe(true);

    const config = await importProduct<{ port: number; db: { host: string; port: number } }>();
    expect(config.port).toBe(3000);
    expect(config.db).toEqual({ host: 'localhost', port: 5432 });
  });

  it('基础 .ts 配置：深度合并属性', async () => {
    writeFile(
      'faapi.config.ts',
      `export default {
  port: 3000,
  db: { host: 'localhost', port: 5432 },
  redis: { host: '127.0.0.1' },
};\n`,
    );

    await compileConfig({ rootDir: tempDir, dist: 'dist' });

    const config = await importProduct<{
      port: number;
      db: { host: string; port: number };
      redis: { host: string };
    }>();
    expect(config.db).toEqual({ host: 'localhost', port: 5432 });
    expect(config.redis).toEqual({ host: '127.0.0.1' });
    expect(config.port).toBe(3000);
  });

  it('支持 .js 配置文件', async () => {
    writeFile('faapi.config.js', `export default { port: 9090 };\n`);

    await compileConfig({ rootDir: tempDir, dist: 'dist' });

    const config = await importProduct<{ port: number }>();
    expect(config.port).toBe(9090);
  });

  it('配置文件的相对 import 保留为 external（运行时从 dist 加载）', async () => {
    writeFile(
      'faapi.config.ts',
      `import { baseConfig } from './base';
export default { ...baseConfig, port: 7070 };\n`,
    );
    writeFile('base.ts', `export const baseConfig = { db: { host: 'from-base' } };\n`);

    await compileConfig({ rootDir: tempDir, dist: 'dist' });

    // faapi-config.js（入口产物）应保留 import './faapi.config.js'（不 inline）
    const entryProduct = readFileSync(join(tempDir, 'dist', 'faapi-config.js'), 'utf-8');
    expect(entryProduct).toMatch(/from\s+['"]\.\/faapi\.config\.js['"]/);

    // faapi.config.js（config 源编译产物）应存在，且保留 import './base.js'
    expect(existsSync(join(tempDir, 'dist', 'faapi.config.js'))).toBe(true);
    const configProduct = readFileSync(join(tempDir, 'dist', 'faapi.config.js'), 'utf-8');
    expect(configProduct).toMatch(/from\s+['"]\.\/base\.js['"]/);

    // base.js（项目模块编译产物）应存在
    expect(existsSync(join(tempDir, 'dist', 'base.js'))).toBe(true);

    // 运行时 import 入口产物，链式加载 faapi.config.js → base.js
    const config = await importProduct<{ port: number; db: { host: string } }>();
    expect(config.port).toBe(7070);
    expect(config.db).toEqual({ host: 'from-base' });
  });

  it('配置文件的 bare import 保留为 external（不打包进产物）', async () => {
    const sideEffectFlag = join(tempDir, '.side-effect-loaded');
    writeFile(
      'faapi.config.ts',
      `import 'my-side-effect/config';
export default { port: 5555 };\n`,
    );
    writeFile(
      'node_modules/my-side-effect/package.json',
      `{
  "name": "my-side-effect",
  "version": "1.0.0",
  "type": "module",
  "exports": { "./config": "./config.js" }
}\n`,
    );
    writeFile(
      'node_modules/my-side-effect/config.js',
      `import { writeFileSync } from 'node:fs';
writeFileSync('${sideEffectFlag}', 'loaded');\n`,
    );

    await compileConfig({ rootDir: tempDir, dist: 'dist' });

    // faapi.config.js（config 源编译产物）应保留 bare import
    const configProduct = readFileSync(join(tempDir, 'dist', 'faapi.config.js'), 'utf-8');
    expect(configProduct).toMatch(/my-side-effect/);

    // import 入口产物时触发 bare import 副作用（链式加载）
    await importProduct();
    expect(existsSync(sideEffectFlag)).toBe(true);
  });

  it('函数型配置保留（middlewares/extendContext 等）', async () => {
    writeFile(
      'faapi.config.ts',
      `export default {
  extendContext(ctx) {
    ctx.t = (key) => key;
  },
  middlewares: [
    async (ctx, next) => { await next(); },
  ],
};\n`,
    );

    await compileConfig({ rootDir: tempDir, dist: 'dist' });

    const config = await importProduct<{
      extendContext: (ctx: unknown) => void;
      middlewares: Array<(ctx: unknown, next: () => Promise<void>) => Promise<void>>;
    }>();
    expect(typeof config.extendContext).toBe('function');
    expect(Array.isArray(config.middlewares)).toBe(true);
    expect(typeof config.middlewares[0]).toBe('function');

    // 验证函数可正常执行
    const ctx: Record<string, unknown> = {};
    config.extendContext(ctx);
    expect(typeof ctx.t).toBe('function');
    expect((ctx.t as (k: string) => string)('hello')).toBe('hello');
  });

  it('配置文件中的 process.env 表达式保留（运行时读取）', async () => {
    writeFile('faapi.config.ts', `export default { dbPassword: process.env.DB_PASSWORD };\n`);

    await compileConfig({ rootDir: tempDir, dist: 'dist' });

    // 入口产物 faapi-config.js 仅 re-export config 源产物，process.env 表达式在 config 源产物中
    const entryProduct = readFileSync(join(tempDir, 'dist', 'faapi-config.js'), 'utf-8');
    expect(entryProduct).toMatch(/from\s+['"]\.\/faapi\.config\.js['"]/);

    // config 源产物 faapi.config.js 中应保留 process.env.DB_PASSWORD 表达式（不传 define）
    const configProduct = readFileSync(join(tempDir, 'dist', 'faapi.config.js'), 'utf-8');
    expect(configProduct).toMatch(/process\.env\.DB_PASSWORD/);

    // 设置环境变量后 import，运行时读取
    process.env.DB_PASSWORD = 'secret-value';
    const config = await importProduct<{ dbPassword: string }>();
    expect(config.dbPassword).toBe('secret-value');
    delete process.env.DB_PASSWORD;
  });

  it('config import 项目模块，instanceof 跨 config/routes 生效', async () => {
    // 创建项目模块：自定义错误类
    writeFile(
      'src/lib/errors.ts',
      `export class AppError extends Error {
  constructor(public code: string, message?: string) {
    super(message ?? code);
    this.name = 'AppError';
  }
}\n`,
    );

    // 创建 handler：import 并抛出 AppError
    writeFile(
      'src/api/test/handler.ts',
      `import { AppError } from '../../lib/errors';
export function GET() {
  throw new AppError('TEST_CODE', 'test error');
}
// 同时导出 AppError 用于测试比较
export { AppError };\n`,
    );

    // 创建 config：import AppError，中间件用 instanceof 捕获
    writeFile(
      'faapi.config.ts',
      `import { AppError } from './src/lib/errors';
export default {
  middlewares: [
    async (ctx, next) => {
      try {
        await next();
      } catch (err) {
        if (err instanceof AppError) {
          ctx.capturedCode = err.code;
          ctx.isAppError = true;
        } else {
          ctx.isAppError = false;
        }
      }
    },
  ],
  // 导出 AppError 用于测试验证（非生产用法，仅测试用）
  _testAppError: AppError,
};\n`,
    );

    // 编译 config（步骤 1 编译 faapi.config.ts + src/lib/errors.ts；步骤 2 编译入口）
    await compileConfig({ rootDir: tempDir, dist: 'dist' });

    // 编译 routes（编译 handler.ts；src/lib/errors.ts 已编译，覆盖为同一文件）
    await compileDevRoutes({ rootDir: tempDir, dist: 'dist' });

    // 验证产物存在
    expect(existsSync(join(tempDir, 'dist', 'faapi-config.js'))).toBe(true);
    expect(existsSync(join(tempDir, 'dist', 'faapi.config.js'))).toBe(true);
    expect(existsSync(join(tempDir, 'dist', 'lib', 'errors.js'))).toBe(true);
    expect(existsSync(join(tempDir, 'dist', 'api', 'test', 'handler.js'))).toBe(true);

    // 从 config 侧获取 AppError（通过 _testAppError）
    const config = await importProduct<{
      middlewares: Array<
        (ctx: Record<string, unknown>, next: () => Promise<void>) => Promise<void>
      >;
      _testAppError: new (code: string, message?: string) => Error;
    }>();

    // 从 handler 侧获取 AppError
    const handlerMod = (await importWithCacheBust(
      join(tempDir, 'dist', 'api', 'test', 'handler.js'),
    )) as { AppError: new (code: string, message?: string) => Error; GET: () => never };

    // 关键验证：config 侧和 handler 侧的 AppError 是同一个类（同一运行时对象）
    expect(config._testAppError).toBe(handlerMod.AppError);

    // 验证 instanceof 跨边界生效
    const errorFromHandler = new handlerMod.AppError('CODE', 'msg');
    expect(errorFromHandler).toBeInstanceOf(config._testAppError);

    const errorFromConfig = new config._testAppError('CODE', 'msg');
    expect(errorFromConfig).toBeInstanceOf(handlerMod.AppError);

    // 端到端验证：中间件能捕获 handler 抛出的 AppError 并 instanceof 为 true
    const ctx: Record<string, unknown> = {};
    const middleware = config.middlewares[0];
    await middleware(ctx, async () => {
      handlerMod.GET(); // 抛出 AppError
    });

    expect(ctx.isAppError).toBe(true);
    expect(ctx.capturedCode).toBe('TEST_CODE');
  });

  it('入口产物直接 export base（不调 deepMerge）', async () => {
    writeFile('faapi.config.ts', `export default { port: 1234 };\n`);

    await compileConfig({ rootDir: tempDir, dist: 'dist' });

    // 入口产物应直接 export base（不包含 deepMerge 函数）
    const product = readFileSync(join(tempDir, 'dist', 'faapi-config.js'), 'utf-8');
    expect(product).toMatch(/from\s+['"]\.\/faapi\.config\.js['"]/);
    expect(product).not.toMatch(/deepMerge/);
  });
});
