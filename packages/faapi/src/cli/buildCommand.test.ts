import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildCommand } from './buildCommand';

/**
 * buildCommand 测试：完整构建流程
 *
 * 覆盖：
 * - bundle 模式编译（entries = handler + middlewares）
 * - tree shaking + define 替换 + minifySyntax 死分支删除
 * - 配置文件 build 时预编译合并（faapi.config.ts + faapi.config.production.ts → faapi-config.js）
 * - 产物结构（handler.js / middlewares.js / faapi-routes.js / faapi-config.js / zod.js）
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

  /** 写文件到 tempDir 下指定相对路径 */
  function writeFile(relPath: string, content: string) {
    const abs = join(tempDir, relPath);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content, 'utf-8');
  }

  it('完整构建：bundle + tree shaking + define 替换 + 产物生成', async () => {
    // 共享 utils（验证 splitting chunk 提取）
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
    // middlewares（验证作为独立 entry 编译）
    writeFile(
      'src/api/hello/middlewares.ts',
      `import type { FaapiMiddleware } from '@faapi/faapi';
export default [
  async (ctx, next) => { await next(); },
] satisfies FaapiMiddleware[];\n`,
    );
    // main.ts（框架零入口，不再收集 main.ts 作为 entry）
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

    // 1. 产物文件存在
    expect(existsSync(join(tempDir, 'dist/api/hello/handler.js'))).toBe(true);
    expect(existsSync(join(tempDir, 'dist/api/hello/middlewares.js'))).toBe(true);
    expect(existsSync(join(tempDir, 'dist/faapi-routes.js'))).toBe(true);
    expect(existsSync(join(tempDir, 'dist/faapi-config.js'))).toBe(true);
    expect(existsSync(join(tempDir, 'dist/main.js'))).toBe(true);
    // zod.js（schema 模块）
    expect(existsSync(join(tempDir, 'dist/api/hello/zod.js'))).toBe(true);
    // faapi-helpers.js（coerce 公用函数，因 Query 含 number 字段应生成）
    expect(existsSync(join(tempDir, 'dist/faapi-helpers.js'))).toBe(true);

    // 2. tree shaking：utils.js 不应作为独立文件存在（被 bundle 进 handler 或 chunk）
    expect(existsSync(join(tempDir, 'dist/utils.js'))).toBe(false);

    // 3. define + minifySyntax：process.env.NODE_ENV 被替换，debug 死分支被删除
    const handler = readFileSync(join(tempDir, 'dist/api/hello/handler.js'), 'utf-8');
    expect(handler).not.toMatch(/process\.env\.NODE_ENV/);
    expect(handler).not.toContain('debug: GET /api/hello');
    // unusedHelper 应被 tree shake 掉
    expect(handler).not.toContain('unusedHelper');

    // 4. faapi-routes.js 包含路由清单
    const routes = readFileSync(join(tempDir, 'dist/faapi-routes.js'), 'utf-8');
    expect(routes).toContain('/api/hello');
    expect(routes).toContain('GET');

    // 4.1 dist/main.js 启动入口内容（零入口设计：build 阶段自动生成）
    const mainContent = readFileSync(join(tempDir, 'dist/main.js'), 'utf-8');
    expect(mainContent).toContain("import { createProdApp } from '@faapi/faapi'");
    expect(mainContent).toContain('await createProdApp()');
    expect(mainContent).toContain('await app.listen()');

    // 5. faapi-config.js：build 时合并基础 + production 配置
    //    db.host 被 production 覆盖，db.port 保留基础配置
    const configModule = await import(
      `file://${join(tempDir, 'dist', 'faapi-config.js')}?t=${Date.now()}`
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
});
