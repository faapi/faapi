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
 * - 配置文件 build 时预编译（faapi.config.ts → faapi-config.js）
 * - 产物结构（handler.js / middlewares.js / faapi-routes.js / faapi-config.js / zod.js）
 * - utils.ts 作为独立产物存在（不 bundle inline）
 * - main.js 启动入口注入 loadEnv 调用
 *
 * 默认产物目录为 dist。
 */
describe('buildCommand', () => {
  let tempDir: string;
  const savedNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    tempDir = join(tmpdir(), `faapi-build-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    // build 时 define 把 process.env.NODE_ENV 替换为 "production" 做死代码消除
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

  it('build 清空输出目录：删除路由后旧产物不残留（emptyOutDir 语义）', async () => {
    writeFile('src/api/old/handler.ts', `export function GET() { return 1; }\n`);
    writeFile(
      'tsconfig.json',
      `{ "compilerOptions": { "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler" } }\n`,
    );
    // 第一次构建：产生 old 路由的产物
    await buildCommand({ rootDir: tempDir });
    expect(existsSync(join(tempDir, OUT, 'api/old/handler.js'))).toBe(true);

    // 删除旧路由、新增新路由，再构建
    rmSync(join(tempDir, 'src/api/old'), { recursive: true, force: true });
    writeFile('src/api/new/handler.ts', `export function GET() { return 2; }\n`);
    await buildCommand({ rootDir: tempDir });

    // 旧产物被清空，新产物存在
    expect(existsSync(join(tempDir, OUT, 'api/old/handler.js'))).toBe(false);
    expect(existsSync(join(tempDir, OUT, 'api/new/handler.js'))).toBe(true);
    expect(existsSync(join(tempDir, OUT, 'faapi-routes.js'))).toBe(true);
  }, 20000);

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
    // faapi.config.ts（验证 build 时编译配置）
    writeFile(
      'faapi.config.ts',
      `export default {
  port: 3000,
  db: { host: 'localhost', port: 5432 },
  extendContext(ctx) { ctx.t = (k) => k; },
};\n`,
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
    //    注入 NODE_ENV 兜底 + loadEnv 调用
    const mainContent = readFileSync(join(tempDir, OUT, 'main.js'), 'utf-8');
    expect(mainContent).toContain("import { createProdApp, loadEnv } from '@faapi/faapi'");
    expect(mainContent).toContain("if (!process.env.NODE_ENV) process.env.NODE_ENV = 'production'");
    expect(mainContent).toContain('loadEnv(process.cwd())');
    expect(mainContent).toContain('await createProdApp()');
    expect(mainContent).toContain('await app.listen()');

    // 6. faapi-config.js：build 时编译基础配置
    //    db.host 为基础配置值（多环境差异通过 .env 文件实现，见 loadEnv）
    const configModule = await import(
      `file://${join(tempDir, OUT, 'faapi-config.js')}?t=${Date.now()}`
    );
    const config = configModule.default as {
      port: number;
      db: { host: string; port: number };
      extendContext: (ctx: Record<string, unknown>) => void;
    };
    expect(config.port).toBe(3000);
    expect(config.db).toEqual({ host: 'localhost', port: 5432 });
    expect(typeof config.extendContext).toBe('function');
    // 函数可执行
    const ctx: Record<string, unknown> = {};
    config.extendContext(ctx);
    expect((ctx.t as (k: string) => string)('hello')).toBe('hello');
  }, 15000);

  it('本地 TS 插件：config.plugins 的 path 声明编译到 dist（prod 可加载）', async () => {
    writeFile('src/api/hello/handler.ts', `export function GET() { return 'ok'; }\n`);
    // src 内依赖：插件 import 无扩展名
    writeFile('src/lib/helper.ts', `export function greet() { return 'hi'; }\n`);
    writeFile(
      'plugins/local-plugin.ts',
      `import { greet } from '../src/lib/helper';
export default {
  name: 'local-plugin',
  setup() { console.log('[local-plugin]', greet()); },
};
`,
    );
    writeFile(
      'faapi.config.ts',
      `export default { plugins: [{ path: './plugins/local-plugin' }] };\n`,
    );

    await buildCommand({ rootDir: tempDir });

    // 插件产物 + src 内依赖产物就位（build 步骤 1 全量编译 src）
    expect(existsSync(join(tempDir, OUT, 'plugins/local-plugin.js'))).toBe(true);
    expect(existsSync(join(tempDir, OUT, 'lib/helper.js'))).toBe(true);

    // 插件产物 import 指向打平的 src 内依赖（剥离前缀 + 子目录回退）
    const pluginProd = readFileSync(join(tempDir, OUT, 'plugins/local-plugin.js'), 'utf-8');
    expect(pluginProd).toMatch(/from ["']\.\.\/lib\/helper\.js["']/);
  }, 20000);

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

    // main.js 包含实际产物目录参数（<dist>，JSON.stringify 生成合法字符串字面量）
    const mainContent = readFileSync(join(tempDir, 'build-output/main.js'), 'utf-8');
    expect(mainContent).toContain('createProdApp({ dist: "build-output" })');
    // 注入 NODE_ENV 兜底 + loadEnv 调用
    expect(mainContent).toContain("if (!process.env.NODE_ENV) process.env.NODE_ENV = 'production'");
    expect(mainContent).toContain('loadEnv(process.cwd())');
    // listen() 无参，端口由运行时 PORT 环境变量决定
    expect(mainContent).toContain('await app.listen()');
  }, 15000);

  it('CLI 选项：--dist 含 Windows 反斜杠路径时 main.js 不被转义损坏', async () => {
    writeFile('src/api/hello/handler.ts', `export function GET() { return 'ok'; }\n`);
    writeFile(
      'tsconfig.json',
      `{ "compilerOptions": { "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler" } }\n`,
    );

    // 模拟 Windows 用户传入反斜杠路径：裸字符串插值会把 \b 变成退格转义
    await buildCommand({ rootDir: tempDir, dist: '.\\build' });

    const mainContent = readFileSync(join(tempDir, '.\\build', 'main.js'), 'utf-8');
    // 生成的必须是合法字符串字面量（\\ 转义），运行时取值仍为 .\build
    expect(mainContent).toContain('createProdApp({ dist: ".\\\\build" })');
    // 反推验证：eval 字面量还原出原始路径
    const literal = mainContent.match(/createProdApp\(\{ dist: (".*") \}\)/)?.[1];
    expect(literal ? JSON.parse(literal) : null).toBe('.\\build');
  }, 15000);

  it('tool 产物生成：faapi-tools.js + tool zod.js', async () => {
    // tool 1
    writeFile(
      'src/tools/weather/handler.ts',
      `export interface WeatherInput { city: string }
/** 获取天气 */
export function getWeather(input: WeatherInput) { return 'sunny'; }\n`,
    );
    // tool 2
    writeFile(
      'src/tools/web-search/handler.ts',
      `export interface SearchInput { query: string }
/** 网页搜索 */
export function search(input: SearchInput) { return 'result'; }\n`,
    );
    // 路由（build 需要至少一个路由文件才不提前 return）
    writeFile('src/api/hello/handler.ts', `export function GET() { return 'ok'; }\n`);
    writeFile(
      'tsconfig.json',
      `{ "compilerOptions": { "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler" } }\n`,
    );

    await buildCommand({ rootDir: tempDir });

    // faapi-tools.js 存在
    expect(existsSync(join(tempDir, OUT, 'faapi-tools.js'))).toBe(true);

    // tool handler.js 编译产物存在（src/** 全量编译覆盖 tools）
    expect(existsSync(join(tempDir, OUT, 'tools/weather/handler.js'))).toBe(true);
    expect(existsSync(join(tempDir, OUT, 'tools/web-search/handler.js'))).toBe(true);

    // tool zod.js 生成（与 handler.js 同级）
    expect(existsSync(join(tempDir, OUT, 'tools/weather/zod.js'))).toBe(true);
    expect(existsSync(join(tempDir, OUT, 'tools/web-search/zod.js'))).toBe(true);

    // faapi-tools.js 内容包含 tool 清单
    const toolsContent = readFileSync(join(tempDir, OUT, 'faapi-tools.js'), 'utf-8');
    expect(toolsContent).toContain('weather.getWeather');
    expect(toolsContent).toContain('web-search.search');
    expect(toolsContent).toContain('获取天气'); // description
    expect(toolsContent).toContain('WeatherInput'); // inputTypeName
  }, 15000);

  it('无 tool 文件时生成空 faapi-tools.js', async () => {
    writeFile('src/api/hello/handler.ts', `export function GET() { return 'ok'; }\n`);
    writeFile(
      'tsconfig.json',
      `{ "compilerOptions": { "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler" } }\n`,
    );

    await buildCommand({ rootDir: tempDir });

    // faapi-tools.js 存在（空清单）
    expect(existsSync(join(tempDir, OUT, 'faapi-tools.js'))).toBe(true);
    const toolsContent = readFileSync(join(tempDir, OUT, 'faapi-tools.js'), 'utf-8');
    expect(toolsContent).toContain('export const tools = []');
  }, 15000);
});
