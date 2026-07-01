import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import {
  serializeRoutes,
  writeRoutesModule,
  hydrateRoutes,
  type SerializedRouteManifest,
} from './generateRoutes';
import { invalidateMiddlewareCache } from '../middleware/loadMiddlewares';
import type { RouteManifest, WsRouteManifest } from '../router/routeTypes';

/**
 * generateRoutes 测试：build 时序列化路由清单 → 写 JS 模块 → start 时水合还原
 *
 * 覆盖：
 * - serializeRoutes：filePath 转 prd 形式、middlewarePaths 收集顺序与转换
 * - writeRoutesModule：写入可被 import 的 ESM 模块
 * - hydrateRoutes：按 middlewarePaths 加载并合并中间件（洋葱模型 + 注入器覆盖）
 * - 端到端往返：serialize → write → import → hydrate
 */
describe('generateRoutes', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(
      tmpdir(),
      `faapi-gen-routes-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tempDir, { recursive: true });
    invalidateMiddlewareCache();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    invalidateMiddlewareCache();
  });

  // 构造最小路由清单
  function makeRoutes(filePath = 'api/user/handler.ts'): RouteManifest {
    return [
      {
        method: 'GET',
        urlPath: '/api/user',
        filePath,
        paramNames: [],
        isDynamic: false,
      },
    ];
  }

  function makeWsRoutes(filePath = 'api/chat/handler.ts'): WsRouteManifest {
    return [
      {
        urlPath: '/api/chat',
        filePath,
        paramNames: [],
        isDynamic: false,
      },
    ];
  }

  describe('serializeRoutes', () => {
    it('filePath 由 dev 形式转为 prd 形式（.ts → .js，加 dist/ 前缀）', () => {
      const routes = makeRoutes('api/user/handler.ts');
      const manifest = serializeRoutes(routes, [], tempDir);

      expect(manifest.routes[0].filePath).toBe('dist/api/user/handler.js');
    });

    it('已是 dist/ 前缀的 filePath 不重复添加前缀', () => {
      const routes = makeRoutes('dist/api/user/handler.js');
      const manifest = serializeRoutes(routes, [], tempDir);

      expect(manifest.routes[0].filePath).toBe('dist/api/user/handler.js');
    });

    it('保留 method/urlPath/paramNames/isDynamic/isCatchAll', () => {
      const routes: RouteManifest = [
        {
          method: 'GET',
          urlPath: '/api/post/[id]',
          filePath: 'api/post/[id]/handler.ts',
          paramNames: ['id'],
          isDynamic: true,
          isCatchAll: true,
        },
      ];
      const manifest = serializeRoutes(routes, [], tempDir);

      expect(manifest.routes[0]).toMatchObject({
        method: 'GET',
        urlPath: '/api/post/[id]',
        paramNames: ['id'],
        isDynamic: true,
        isCatchAll: true,
      });
    });

    it('无中间件时 middlewarePaths 为空数组', () => {
      const routes = makeRoutes('api/user/handler.ts');
      const manifest = serializeRoutes(routes, [], tempDir);

      expect(manifest.routes[0].middlewarePaths).toEqual([]);
    });

    it('收集从根到路由目录的中间件路径，根在前', () => {
      // 目录结构：
      //   middlewares.ts           （根级）
      //   api/middlewares.ts       （api 级）
      //   api/user/middlewares.ts  （路由级）
      //   api/user/handler.ts      （路由）
      mkdirSync(join(tempDir, 'api/user'), { recursive: true });
      writeFileSync(join(tempDir, 'middlewares.ts'), `export default [];\n`);
      writeFileSync(join(tempDir, 'api/middlewares.ts'), `export default [];\n`);
      writeFileSync(join(tempDir, 'api/user/middlewares.ts'), `export default [];\n`);
      writeFileSync(join(tempDir, 'api/user/handler.ts'), `export function GET() {}\n`);

      const routes = makeRoutes('api/user/handler.ts');
      const manifest = serializeRoutes(routes, [], tempDir);

      // 根在前，路由目录在后；路径为 prd 形式绝对路径（dist 前缀 + .js）
      expect(manifest.routes[0].middlewarePaths).toEqual([
        join(tempDir, 'dist/middlewares.js'),
        join(tempDir, 'dist/api/middlewares.js'),
        join(tempDir, 'dist/api/user/middlewares.js'),
      ]);
    });

    it('优先匹配 .ts，回退 .js', () => {
      // 同时存在 .ts 和 .js 时优先 .ts（dev 形式）
      mkdirSync(join(tempDir, 'api'), { recursive: true });
      writeFileSync(join(tempDir, 'api/middlewares.ts'), `export default [];\n`);
      writeFileSync(join(tempDir, 'api/middlewares.js'), `export default [];\n`);
      writeFileSync(join(tempDir, 'api/handler.ts'), `export function GET() {}\n`);

      const routes = makeRoutes('api/handler.ts');
      const manifest = serializeRoutes(routes, [], tempDir);

      // .ts 被选中，但输出仍为 prd 形式（.js）
      expect(manifest.routes[0].middlewarePaths).toEqual([
        join(tempDir, 'dist/api/middlewares.js'),
      ]);
    });

    it('仅回退到 .js 时也能收集（prd 残留场景）', () => {
      mkdirSync(join(tempDir, 'api'), { recursive: true });
      writeFileSync(join(tempDir, 'api/middlewares.js'), `export default [];\n`);
      writeFileSync(join(tempDir, 'api/handler.ts'), `export function GET() {}\n`);

      const routes = makeRoutes('api/handler.ts');
      const manifest = serializeRoutes(routes, [], tempDir);

      expect(manifest.routes[0].middlewarePaths).toEqual([
        join(tempDir, 'dist/api/middlewares.js'),
      ]);
    });

    it('序列化 WS 路由（无 method 字段）', () => {
      const wsRoutes = makeWsRoutes('api/chat/handler.ts');
      const manifest = serializeRoutes([], wsRoutes, tempDir);

      expect(manifest.wsRoutes[0].filePath).toBe('dist/api/chat/handler.js');
      expect(manifest.wsRoutes[0].urlPath).toBe('/api/chat');
      expect('method' in manifest.wsRoutes[0]).toBe(false);
    });

    it('不序列化 middlewares/injectors 函数引用', () => {
      const routes: RouteManifest = [
        {
          method: 'GET',
          urlPath: '/api/user',
          filePath: 'api/user/handler.ts',
          paramNames: [],
          isDynamic: false,
          middlewares: [async (_ctx, next) => next()],
          injectors: { db: () => ({} as never) },
        },
      ];
      const manifest = serializeRoutes(routes, [], tempDir);

      // 函数引用不进入序列化结果，仅保留 middlewarePaths
      expect('middlewares' in manifest.routes[0]).toBe(false);
      expect('injectors' in manifest.routes[0]).toBe(false);
    });
  });

  describe('writeRoutesModule', () => {
    it('写入可被 import 的 ESM 模块', async () => {
      const manifest: SerializedRouteManifest = {
        routes: [
          {
            method: 'GET',
            urlPath: '/api/user',
            filePath: 'dist/api/user/handler.js',
            paramNames: [],
            isDynamic: false,
            middlewarePaths: [],
          },
        ],
        wsRoutes: [],
      };

      const outputPath = join(tempDir, 'faapi-routes.js');
      await writeRoutesModule(manifest, outputPath);

      expect(existsSync(outputPath)).toBe(true);

      // 动态 import 验证生成的 JS 合法
      const loaded = (await import(pathToFileURL(outputPath).href)) as {
        routes: unknown;
        wsRoutes: unknown;
      };
      expect(Array.isArray(loaded.routes)).toBe(true);
      expect(Array.isArray(loaded.wsRoutes)).toBe(true);
      expect((loaded.routes as { length: number }[])[0]).toBeDefined();
    });

    it('往返数据一致（serialize → write → import）', async () => {
      const routes = makeRoutes('api/user/handler.ts');
      const manifest = serializeRoutes(routes, [], tempDir);

      const outputPath = join(tempDir, 'faapi-routes.js');
      await writeRoutesModule(manifest, outputPath);

      const loaded = (await import(pathToFileURL(outputPath).href)) as SerializedRouteManifest;
      expect(loaded.routes).toEqual(manifest.routes);
      expect(loaded.wsRoutes).toEqual(manifest.wsRoutes);
    });
  });

  describe('hydrateRoutes', () => {
    it('空 middlewarePaths 时 middlewares/injectors 为 undefined', async () => {
      const manifest: SerializedRouteManifest = {
        routes: [
          {
            method: 'GET',
            urlPath: '/api/user',
            filePath: 'dist/api/user/handler.js',
            paramNames: [],
            isDynamic: false,
            middlewarePaths: [],
          },
        ],
        wsRoutes: [],
      };

      const { routes, wsRoutes } = await hydrateRoutes(manifest);

      expect(routes[0].middlewares).toBeUndefined();
      expect(routes[0].injectors).toBeUndefined();
      expect(wsRoutes).toHaveLength(0);
    });

    it('按 middlewarePaths 加载中间件并合并', async () => {
      // 在 dist/ 下创建 prd 形式中间件 .js 文件（模拟 build 产物）
      mkdirSync(join(tempDir, 'dist/api/user'), { recursive: true });
      writeFileSync(
        join(tempDir, 'dist/api/middlewares.js'),
        `export default [async (ctx, next) => { ctx.mark = 'api'; await next(); }];\n`,
      );
      writeFileSync(
        join(tempDir, 'dist/api/user/middlewares.js'),
        `export default [async (ctx, next) => { ctx.mark = 'user'; await next(); }];\n`,
      );

      const manifest: SerializedRouteManifest = {
        routes: [
          {
            method: 'GET',
            urlPath: '/api/user',
            filePath: 'dist/api/user/handler.js',
            paramNames: [],
            isDynamic: false,
            middlewarePaths: [
              join(tempDir, 'dist/api/middlewares.js'),
              join(tempDir, 'dist/api/user/middlewares.js'),
            ],
          },
        ],
        wsRoutes: [],
      };

      const { routes } = await hydrateRoutes(manifest);

      // 父级在前，子级追加在后（洋葱模型内层）
      expect(routes[0].middlewares).toHaveLength(2);
      expect(typeof routes[0].middlewares![0]).toBe('function');
      expect(typeof routes[0].middlewares![1]).toBe('function');
    });

    it('子级注入器覆盖父级同名注入器', async () => {
      mkdirSync(join(tempDir, 'dist/api/user'), { recursive: true });
      writeFileSync(
        join(tempDir, 'dist/api/middlewares.js'),
        `export const injectors = { db: () => 'parent-db', user: () => 'parent-user' };\nexport default [];\n`,
      );
      writeFileSync(
        join(tempDir, 'dist/api/user/middlewares.js'),
        `export const injectors = { db: () => 'child-db' };\nexport default [];\n`,
      );

      const manifest: SerializedRouteManifest = {
        routes: [
          {
            method: 'GET',
            urlPath: '/api/user',
            filePath: 'dist/api/user/handler.js',
            paramNames: [],
            isDynamic: false,
            middlewarePaths: [
              join(tempDir, 'dist/api/middlewares.js'),
              join(tempDir, 'dist/api/user/middlewares.js'),
            ],
          },
        ],
        wsRoutes: [],
      };

      const { routes } = await hydrateRoutes(manifest);

      // 测试中注入器忽略 ctx，断言时省略入参（类型断言为无参函数）
      const dbInjector = routes[0].injectors!.db as () => string;
      const userInjector = routes[0].injectors!.user as () => string;
      expect(dbInjector()).toBe('child-db'); // 子级覆盖
      expect(userInjector()).toBe('parent-user'); // 父级保留
    });

    it('水合 WS 路由（同样加载中间件）', async () => {
      mkdirSync(join(tempDir, 'dist/api/chat'), { recursive: true });
      writeFileSync(
        join(tempDir, 'dist/api/chat/middlewares.js'),
        `export default [async (ctx, next) => { await next(); }];\n`,
      );

      const manifest: SerializedRouteManifest = {
        routes: [],
        wsRoutes: [
          {
            urlPath: '/api/chat',
            filePath: 'dist/api/chat/handler.js',
            paramNames: [],
            isDynamic: false,
            middlewarePaths: [join(tempDir, 'dist/api/chat/middlewares.js')],
          },
        ],
      };

      const { wsRoutes } = await hydrateRoutes(manifest);

      expect(wsRoutes[0].middlewares).toHaveLength(1);
      expect(typeof wsRoutes[0].middlewares![0]).toBe('function');
    });
  });

  describe('端到端往返：serialize → write → import → hydrate', () => {
    it('完整往返还原路由清单（含中间件）', async () => {
      // 创建 dev 形式源文件
      mkdirSync(join(tempDir, 'api/user'), { recursive: true });
      writeFileSync(join(tempDir, 'middlewares.ts'), `export default [];\n`);
      writeFileSync(
        join(tempDir, 'api/middlewares.ts'),
        `export default [async (ctx, next) => { await next(); }];\nexport const injectors = { db: () => 'dev-db' };\n`,
      );
      writeFileSync(join(tempDir, 'api/user/handler.ts'), `export function GET() {}\n`);

      // 1. serialize（build 时，检查 dev .ts 文件，输出 prd 路径）
      const routes = makeRoutes('api/user/handler.ts');
      const serialized = serializeRoutes(routes, [], tempDir);

      // 2. write 模块
      const outputPath = join(tempDir, 'dist/faapi-routes.js');
      await writeRoutesModule(serialized, outputPath);

      // 3. 模拟 esbuild 编译：把 dev .ts 中间件编译为 dist/ 下 .js
      //    （测试中直接复制为 .js，内容已是合法 ESM）
      mkdirSync(join(tempDir, 'dist/api'), { recursive: true });
      writeFileSync(
        join(tempDir, 'dist/middlewares.js'),
        `export default [];\n`,
      );
      writeFileSync(
        join(tempDir, 'dist/api/middlewares.js'),
        `export default [async (ctx, next) => { await next(); }];\nexport const injectors = { db: () => 'prd-db' };\n`,
      );

      // 4. import 清单
      invalidateMiddlewareCache();
      const loaded = (await import(pathToFileURL(outputPath).href)) as SerializedRouteManifest;

      // 5. hydrate
      const { routes: hydratedRoutes } = await hydrateRoutes(loaded);

      expect(hydratedRoutes[0].filePath).toBe('dist/api/user/handler.js');
      expect(hydratedRoutes[0].urlPath).toBe('/api/user');
      // 根 middlewares.ts 导出空数组 → 不产生中间件项；api/middlewares.ts 产生 1 个
      expect(hydratedRoutes[0].middlewares).toHaveLength(1);
      const dbInjector = hydratedRoutes[0].injectors!.db as () => string;
      expect(dbInjector()).toBe('prd-db');
    });
  });
});
