import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compileConfig } from './compileConfig';
import { importWithCacheBust } from '../utils/importWithCacheBust';

/**
 * compileConfig 测试：build 时编译合并配置文件
 *
 * 覆盖：
 * - 无配置文件：不生成产物
 * - 仅基础配置：编译并输出 dist/faapi-config.js
 * - 基础 + env 配置：深度合并
 * - .ts / .js 配置文件
 * - 配置文件相对 import 被 bundle
 * - 配置文件 bare import 保留 external
 * - 函数型配置保留（middlewares/extendContext 等）
 * - deepMerge 特殊对象直接替换（数组/Date 等）
 */
describe('compileConfig', () => {
  let tempDir: string;
  const savedFaapiEnv = process.env.FAAPI_ENV;
  const savedNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    tempDir = join(
      tmpdir(),
      `faapi-compile-config-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tempDir, { recursive: true });
    delete process.env.FAAPI_ENV;
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    if (savedFaapiEnv === undefined) delete process.env.FAAPI_ENV;
    else process.env.FAAPI_ENV = savedFaapiEnv;
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedNodeEnv;
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
    const result = await compileConfig({ rootDir: tempDir, outDir: 'dist' });
    expect(result.generated).toBe(false);
    expect(existsSync(join(tempDir, 'dist', 'faapi-config.js'))).toBe(false);
  });

  it('仅基础配置 .ts：编译并输出 dist/faapi-config.js', async () => {
    writeFile(
      'faapi.config.ts',
      `export default { port: 3000, db: { host: 'localhost', port: 5432 } };\n`,
    );

    const result = await compileConfig({ rootDir: tempDir, outDir: 'dist' });
    expect(result.generated).toBe(true);
    expect(existsSync(join(tempDir, 'dist', 'faapi-config.js'))).toBe(true);

    const config = await importProduct<{ port: number; db: { host: string; port: number } }>();
    expect(config.port).toBe(3000);
    expect(config.db).toEqual({ host: 'localhost', port: 5432 });
  });

  it('基础 .ts + env .ts：深度合并', async () => {
    writeFile(
      'faapi.config.ts',
      `export default {
  port: 3000,
  db: { host: 'localhost', port: 5432 },
  redis: { host: '127.0.0.1' },
};\n`,
    );
    writeFile(
      'faapi.config.production.ts',
      `export default {
  db: { host: 'db.production.com' },
};\n`,
    );
    process.env.NODE_ENV = 'production';

    await compileConfig({ rootDir: tempDir, outDir: 'dist' });

    const config = await importProduct<{
      port: number;
      db: { host: string; port: number };
      redis: { host: string };
    }>();
    // db 深度合并：host 被覆盖，port 保留
    expect(config.db).toEqual({ host: 'db.production.com', port: 5432 });
    // redis 未被覆盖，保留原值
    expect(config.redis).toEqual({ host: '127.0.0.1' });
    // port 未被覆盖
    expect(config.port).toBe(3000);
  });

  it('FAAPI_ENV 优先于 NODE_ENV 决定加载哪个 env 配置', async () => {
    writeFile('faapi.config.ts', `export default { db: { host: 'localhost' } };\n`);
    writeFile('faapi.config.staging.ts', `export default { db: { host: 'staging.db.com' } };\n`);
    writeFile(
      'faapi.config.production.ts',
      `export default { db: { host: 'db.production.com' } };\n`,
    );
    process.env.NODE_ENV = 'production';
    process.env.FAAPI_ENV = 'staging';

    await compileConfig({ rootDir: tempDir, outDir: 'dist' });

    const config = await importProduct<{ db: { host: string } }>();
    expect(config.db.host).toBe('staging.db.com');
  });

  it('env 配置不存在时仅导出基础配置', async () => {
    writeFile('faapi.config.ts', `export default { port: 8080 };\n`);
    process.env.NODE_ENV = 'production';
    // 无 faapi.config.production.ts

    await compileConfig({ rootDir: tempDir, outDir: 'dist' });

    const config = await importProduct<{ port: number }>();
    expect(config.port).toBe(8080);
  });

  it('支持 .js 配置文件', async () => {
    writeFile('faapi.config.js', `export default { port: 9090 };\n`);

    await compileConfig({ rootDir: tempDir, outDir: 'dist' });

    const config = await importProduct<{ port: number }>();
    expect(config.port).toBe(9090);
  });

  it('配置文件的相对 import 被 bundle 进产物', async () => {
    writeFile(
      'faapi.config.ts',
      `import { baseConfig } from './base';
export default { ...baseConfig, port: 7070 };\n`,
    );
    writeFile('base.ts', `export const baseConfig = { db: { host: 'from-base' } };\n`);

    await compileConfig({ rootDir: tempDir, outDir: 'dist' });

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

    await compileConfig({ rootDir: tempDir, outDir: 'dist' });

    // 产物中保留 import 'my-side-effect/config'（external）
    const product = readFileSync(join(tempDir, 'dist', 'faapi-config.js'), 'utf-8');
    expect(product).toMatch(/my-side-effect/);

    // import 产物时触发 bare import 副作用
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

    await compileConfig({ rootDir: tempDir, outDir: 'dist' });

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

  it('deepMerge：数组直接替换（不递归合并）', async () => {
    writeFile('faapi.config.ts', `export default { roles: ['admin', 'user'] };\n`);
    writeFile('faapi.config.production.ts', `export default { roles: ['admin'] };\n`);
    process.env.NODE_ENV = 'production';

    await compileConfig({ rootDir: tempDir, outDir: 'dist' });

    const config = await importProduct<{ roles: string[] }>();
    expect(config.roles).toEqual(['admin']);
  });

  it('配置文件中的 process.env 表达式保留（运行时读取）', async () => {
    writeFile('faapi.config.ts', `export default { dbPassword: process.env.DB_PASSWORD };\n`);

    await compileConfig({ rootDir: tempDir, outDir: 'dist' });

    // 产物中保留 process.env.DB_PASSWORD 表达式
    const product = readFileSync(join(tempDir, 'dist', 'faapi-config.js'), 'utf-8');
    expect(product).toMatch(/process\.env\.DB_PASSWORD/);

    // 设置环境变量后 import，运行时读取
    process.env.DB_PASSWORD = 'secret-value';
    const config = await importProduct<{ dbPassword: string }>();
    expect(config.dbPassword).toBe('secret-value');
    delete process.env.DB_PASSWORD;
  });
});
