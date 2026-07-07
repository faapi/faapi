import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildCommand } from './buildCommand';

/**
 * buildCommand 测试：完整构建流程
 *
 * 覆盖：
 * - 逐文件编译（bundle:false，与 dev 一致）
 * - 配置文件 build 时预编译合并（faapi.config.ts + faapi.config.production.ts → faapi-config.js）
 * - 产物结构（handler.js / middlewares.js / faapi-routes.js / faapi-config.js / zod.js）
 * - utils.ts 作为独立产物存在（不 bundle inline）
 *
 * 默认产物目录为 dist。
 */
describe('buildCommand', () => {
  let tempDir: string;
  const savedNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    tempDir = join(tmpdir(), `faapi-build-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    // compileConfig 按 NODE_ENV 决定加载哪个 env 配置；测试期望合并 production 配置
    process.env.NODE_ENV = 'production';
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedNodeEnv;
  });

  /** 默认 prod 产物目录（dist） */
  const OUT = 'dist';

  /** 写文件到 tempDir 下指定相对路径 */
  function writeFile(relPath: string, content: string) {
    const abs = join(tempDir, relPath);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content, 'utf-8');
  }

  it('完整构建：逐文件编译 + 产物生成 + 配置合并', async () => {
    // 共享 utils（验证不 bundle inline，作为独立产物存在）
    writeFile(
      'src/utils.ts',
      `export function usedHelper() { return 'used'; }
export function unusedHelper() { return 'unused'; }\n`,
    );
    // handler 引用 utils，含 dev-only 调试代码
    writeFile(
      'src/api/hello/handler.ts',
      `import { usedHelper } from '../../utils';
export interface Query { page: number }

export function GET(query: Query) {
  if (process.env.NODE_ENV !== 'production') {
    console.log('debug: GET /api/hello', query.page);
  }
  return { page: query.page, helper: usedHelper() };
}\n`,
    );
    // middlewares（验证独立编译）
    writeFile(
      'src/api/hello/middlewares.ts',
      `import type { FaapiMiddleware } from '@faapi/faapi';
export default [
  async (ctx, next) => { await next(); },
] satisfies FaapiMiddleware[];\n`,
    );
    // faapi.config.ts（验证 build 时编译合并配置）
    writeFile(
      'faapi.config.ts',
      `export default {
  port: 3000,
  db: { host: 'localhost', port: 5432 },
  extendContext(ctx) { ctx.t = (k) => k; },
};\n`,
    );
    // faapi.config.production.ts（验证 env 合并）
    writeFile(
      'faapi.config.production.ts',
      `export default { db: { host: 'db.production.com' } };\n`,
    );
    // tsconfig（别名插件需要）
    writeFile(
      'tsconfig.json',
      `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true
  }
}\n`,
    );

    await buildCommand({ rootDir: tempDir });

    // 1. 产物文件存在（默认输出到 dist/）
    expect(existsSync(join(tempDir, OUT, 'api/hello/handler.js'))).toBe(true);
    expect(existsSync(join(tempDir, OUT, 'api/hello/middlewares.js'))).toBe(true);
    expect(existsSync(join(tempDir, OUT, 'faapi-routes.js'))).toBe(true);
    expect(existsSync(join(tempDir, OUT, 'faapi-config.js'))).toBe(true);
    expect(existsSync(join(tempDir, OUT, 'faapi.config.js'))).toBe(true);
    expect(existsSync(join(tempDir, OUT, 'main.js'))).toBe(true);
    // zod.js（schema 模块）
    expect(existsSync(join(tempDir, OUT, 'api/hello/zod.js'))).toBe(true);
    // faapi-helpers.js（coerce 公用函数，因 Query 含 number 字段应生成）
    expect(existsSync(join(tempDir, OUT, 'faapi-helpers.js'))).toBe(true);

    // 2. utils.js 作为独立产物存在（不 bundle inline）
    expect(existsSync(join(tempDir, OUT, 'utils.js'))).toBe(true);
    // 未引用的 export 也保留（不做 tree shaking）
    const utilsProduct = readFileSync(join(tempDir, OUT, 'utils.js'), 'utf-8');
    expect(utilsProduct).toContain('usedHelper');
    expect(utilsProduct).toContain('unusedHelper');

    // 3. process.env.NODE_ENV 编译期替换为 "production"（define）
    //    if (process.env.NODE_ENV !== 'production') 变为 if ("production" !== "production") 即 if (false)
    //    minifySyntax 删除死分支，debug 日志不在产物中
    const handler = readFileSync(join(tempDir, OUT, 'api/hello/handler.js'), 'utf-8');
    expect(handler).not.toMatch(/process\.env\.NODE_ENV/);
    expect(handler).not.toContain('debug: GET /api/hello');

    // 4. faapi-routes.js 包含路由清单
    const routes = readFileSync(join(tempDir, OUT, 'faapi-routes.js'), 'utf-8');
    expect(routes).toContain('/api/hello');
    expect(routes).toContain('GET');

    // 5. main.js 启动入口内容（零入口设计：build 阶段自动生成）
    //    默认 dist 不写入 createProdApp 参数（用默认 dist）
    const mainContent = readFileSync(join(tempDir, OUT, 'main.js'), 'utf-8');
    expect(mainContent).toContain("import { createProdApp } from '@faapi/faapi'");
    expect(mainContent).toContain('await createProdApp()');
    expect(mainContent).toContain('await app.listen()');

    // 6. faapi-config.js：build 时合并基础 + production 配置
    //    db.host 被 production 覆盖，db.port 保留基础配置
    const configModule = await import(
      `file://${join(tempDir, OUT, 'faapi-config.js')}?t=${Date.now()}`
    );
    const config = configModule.default as {
      port: number;
      db: { host: string; port: number };
      extendContext: (ctx: Record<string, unknown>) => void;
    };
    expect(config.port).toBe(3000);
    expect(config.db).toEqual({ host: 'db.production.com', port: 5432 });
    expect(typeof config.extendContext).toBe('function');
    // 函数可执行
    const ctx: Record<string, unknown> = {};
    config.extendContext(ctx);
    expect((ctx.t as (k: string) => string)('hello')).toBe('hello');
  }, 15000);

  it('CLI 选项：--port 写入 main.js 的 listen() 调用', async () => {
    writeFile('src/api/hello/handler.ts', `export function GET() { return 'ok'; }\n`);
    writeFile(
      'tsconfig.json',
      `{ "compilerOptions": { "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler" } }\n`,
    );

    await buildCommand({ rootDir: tempDir, port: 8080 });

    const mainContent = readFileSync(join(tempDir, OUT, 'main.js'), 'utf-8');
    expect(mainContent).toContain('await app.listen(8080)');
  }, 15000);

  it('CLI 选项：--dist 改变产物根目录 + 写入 main.js 的 createProdApp 参数', async () => {
    writeFile('src/api/hello/handler.ts', `export function GET() { return 'ok'; }\n`);
    writeFile(
      'tsconfig.json',
      `{ "compilerOptions": { "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler" } }\n`,
    );

    // --dist 是产物输出目录
    await buildCommand({ rootDir: tempDir, dist: 'build-output' });

    // 产物写入 build-output/ 而非默认 dist/
    expect(existsSync(join(tempDir, 'build-output/main.js'))).toBe(true);
    expect(existsSync(join(tempDir, 'build-output/faapi-routes.js'))).toBe(true);
    expect(existsSync(join(tempDir, OUT, 'main.js'))).toBe(false);

    // main.js 包含实际产物目录参数（<dist>）
    const mainContent = readFileSync(join(tempDir, 'build-output/main.js'), 'utf-8');
    expect(mainContent).toContain("createProdApp({ dist: 'build-output' })");
  }, 15000);

  it('CLI 选项：--port + --dist 同时使用', async () => {
    writeFile('src/api/hello/handler.ts', `export function GET() { return 'ok'; }\n`);
    writeFile(
      'tsconfig.json',
      `{ "compilerOptions": { "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler" } }\n`,
    );

    await buildCommand({ rootDir: tempDir, port: 9090, dist: 'custom' });

    const mainContent = readFileSync(join(tempDir, 'custom/main.js'), 'utf-8');
    expect(mainContent).toContain("createProdApp({ dist: 'custom' })");
    expect(mainContent).toContain('await app.listen(9090)');
  }, 15000);
});
