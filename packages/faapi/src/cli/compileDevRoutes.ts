import path from 'node:path';
import fs from 'node:fs';
import fg from 'fast-glob';
import { buildAliasPlugins } from './aliasPlugin';

/** 路由源码目录（写死为 src） */
const APP_DIR = 'src';

/**
 * dev 编译选项
 */
export interface CompileDevOptions {
  /** 项目根目录 */
  rootDir: string;
  /** 输出目录（dev 模式为 `.faapi`） */
  dist: string;
  /**
   * 增量编译：传入要编译的文件列表（绝对路径）。
   * 不传则全量编译 src 下所有 .ts（排除测试文件和声明文件）。
   */
  files?: string[];
  /** 是否输出 esbuild 日志（dev 模式默认静默） */
  logLevel?: 'silent' | 'info';
}

/**
 * 编译结果
 */
export interface CompileResult {
  /** 已编译的文件列表（绝对路径） */
  compiledFiles: string[];
}

/**
 * dev 模式编译 TypeScript：逐文件编译，启动快、增量编译友好
 *
 * 每个 `.ts` 独立编译为 `.js`，不分析 import 关系（`bundle: false`）。
 * 产物**打平 src/ 前缀**：
 * - `src/api/hello/handler.ts` → `<dist>/api/hello/handler.js`
 *
 * 别名在编译时重写为相对路径，运行时无需 loader。
 *
 * 框架采用零入口设计——用户无需编写 main.ts，dev/prod 启动由 CLI 内部编排。
 *
 * @example
 * // 全量编译
 * await compileDevRoutes({ rootDir, dist: '.faapi' });
 * // watch 增量：只编译变化的文件
 * await compileDevRoutes({ rootDir, dist: '.faapi', files: changedFiles });
 */
export async function compileDevRoutes(options: CompileDevOptions): Promise<CompileResult> {
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

  // 构造别名重写插件（无 tsconfig/paths 时为空）
  const plugins = buildAliasPlugins(rootDir);

  // 逐文件编译，outbase 设为 src 以打平产物结构：
  // `src/api/hello/handler.ts` → `<dist>/api/hello/handler.js`（去掉 src/ 前缀）
  //
  // 启用 write: false + 自行原子写（写临时文件 + rename），避免 watch 模式下
  // esbuild 非原子写期间运行时 import 读到半成品产物（alias 未重写完 → 500）。
  // 详见 compileRoutes.md 的"dev 原子写"章节。
  const esbuild = await import('esbuild');
  const outbase = path.resolve(rootDir, APP_DIR);
  const result = await esbuild.build({
    entryPoints,
    outdir: absDist,
    outbase,
    bundle: false,
    platform: 'node',
    format: 'esm',
    sourcemap: true,
    packages: 'external',
    plugins,
    logLevel,
    write: false,
  });

  // 原子写：esbuild 返回 outputFiles（内存内容），逐个写临时文件 + rename
  // rename 在同一文件系统上是原子的（POSIX），HTTP 请求要么看到旧文件要么看到新文件
  if (result.outputFiles) {
    await Promise.all(
      result.outputFiles.map(async (file) => {
        await fs.promises.mkdir(path.dirname(file.path), { recursive: true });
        const tmp = `${file.path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
        await fs.promises.writeFile(tmp, file.contents);
        await fs.promises.rename(tmp, file.path);
      }),
    );
  }

  return { compiledFiles: entryPoints };
}

/**
 * 扫描 src 下的所有 .ts 文件（排除测试文件和声明文件）
 *
 * 用于全量编译和 watch 监听。
 */
export async function collectSourceFiles(rootDir: string): Promise<string[]> {
  return fg([`${APP_DIR}/**/*.ts`], {
    cwd: rootDir,
    onlyFiles: true,
    absolute: true,
    ignore: ['**/*.test.ts', '**/*.e2e.test.ts', '**/*.d.ts'],
  });
}
