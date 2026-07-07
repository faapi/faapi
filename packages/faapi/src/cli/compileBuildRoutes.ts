import path from 'node:path';
import fs from 'node:fs';
import fg from 'fast-glob';
import { buildAliasPlugins } from './aliasPlugin';
import type { CompileResult } from './compileDevRoutes';

/** 路由源码目录（写死为 src） */
const APP_DIR = 'src';

/**
 * build 编译选项
 */
export interface CompileBuildOptions {
  /** 项目根目录 */
  rootDir: string;
  /** 输出目录（build 模式为 `.faapi/build`） */
  dist: string;
  /**
   * 增量编译：传入要编译的文件列表（绝对路径）。
   * 不传则全量编译 src 下所有 .ts（排除测试文件和声明文件）。
   */
  files?: string[];
  /** 是否输出 esbuild 日志（build 模式默认静默） */
  logLevel?: 'silent' | 'info';
}

/**
 * build 模式编译 TypeScript：逐文件编译 + 编译期常量替换 + 死分支删除
 *
 * 每个 `.ts` 独立编译为 `.js`，不分析 import 关系（`bundle: false`）。
 * 产物**打平 src/ 前缀**：
 * - `src/api/hello/handler.ts` → `<dist>/api/hello/handler.js`
 *
 * 别名在编译时重写为相对路径，运行时无需 loader。
 *
 * **与 dev 模式的差异**：build 模式额外启用 `define` + `minifySyntax`，
 * 在编译期把 `process.env.NODE_ENV` 替换为 `"production"` 并删除 `if (false) {...}` 死分支。
 * 两者在 `bundle: false` 下均生效（单文件级别优化，不需要跨文件分析）。
 *
 * **为什么不用 bundle 模式**：bundle 模式会把 import 的项目模块 inline 进产物,
 * 导致 `faapi.config.ts` 中的 `instanceof` 对项目自定义错误类失效
 * （config 和 routes 各自打包出独立的项目类副本）。
 * 逐文件编译保证每个源文件对应唯一一份产物,config 和 routes 共享同一运行时对象。
 *
 * **tree shaking 不可用**：`bundle: false` 不分析跨文件引用图，未引用的 export 不会被删除。
 * 这恰好符合设计意图——保留所有 export，让 config 和 routes 共享同一运行时对象。
 *
 * 框架采用零入口设计——用户无需编写 main.ts，dev/prod 启动由 CLI 内部编排。
 *
 * @example
 * await compileBuildRoutes({ rootDir, dist: '.faapi/build' });
 */
export async function compileBuildRoutes(options: CompileBuildOptions): Promise<CompileResult> {
  const { rootDir, dist, files, logLevel = 'silent' } = options;

  // 收集要编译的文件：files 优先，否则全量扫描 src 下所有 .ts
  const entryPoints =
    files ??
    (await fg([`${APP_DIR}/**/*.ts`], {
      cwd: rootDir,
      onlyFiles: true,
      absolute: true,
      ignore: ['**/*.test.ts', '**/*.e2e.test.ts', '**/*.d.ts'],
    }));

  if (entryPoints.length === 0) {
    return { compiledFiles: [] };
  }

  // 确保输出目录存在
  const absDist = path.resolve(rootDir, dist);
  await fs.promises.mkdir(absDist, { recursive: true });

  // 构造别名重写插件（无 tsconfig/paths 时为空，相对路径重写仍生效）
  const plugins = buildAliasPlugins(rootDir);

  // 逐文件编译，outbase 设为 src 以打平产物结构：
  // `src/api/hello/handler.ts` → `<dist>/api/hello/handler.js`（去掉 src/ 前缀）
  //
  // define + minifySyntax：编译期把 process.env.NODE_ENV 替换为 "production"，
  // 删除 if (false) {...} 死分支。两者在 bundle:false 下均生效（单文件级别优化）。
  const esbuild = await import('esbuild');
  const outbase = path.resolve(rootDir, APP_DIR);
  await esbuild.build({
    entryPoints,
    outdir: absDist,
    outbase,
    bundle: false,
    platform: 'node',
    format: 'esm',
    sourcemap: true,
    packages: 'external',
    plugins,
    define: { 'process.env.NODE_ENV': '"production"' },
    minifySyntax: true,
    logLevel,
  });

  return { compiledFiles: entryPoints };
}
