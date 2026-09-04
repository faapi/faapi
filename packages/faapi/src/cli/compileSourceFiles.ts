import path from 'node:path';
import fs from 'node:fs';
import fg from 'fast-glob';
import { buildAliasPlugins } from './aliasPlugin';
import { APP_DIR } from '../utils/prodPaths';

/**
 * 编译结果
 */
export interface CompileResult {
  /** 已编译的文件列表（绝对路径） */
  compiledFiles: string[];
}

export interface CompileSourceFilesOptions {
  /** 项目根目录 */
  rootDir: string;
  /** 输出目录（dev 为 `.faapi`，build 为 `dist`） */
  dist: string;
  /**
   * 增量编译：传入要编译的文件列表（绝对路径）。
   * 不传则全量编译 src 下所有 .ts（排除测试文件和声明文件）。
   */
  files?: string[];
  /** 是否输出 esbuild 日志（默认静默） */
  logLevel?: 'silent' | 'info';
  /**
   * prod 语义：`define` 把 `process.env.NODE_ENV` 编译期替换为 `"production"` +
   * `minifySyntax` 删除死分支（两者在 `bundle: false` 下均生效，单文件级别优化）。
   */
  production?: boolean;
  /**
   * dev 语义：原子写（write: false + 临时文件 + rename），避免 watch 模式下
   * esbuild 非原子写期间运行时 import 读到半成品产物。
   */
  atomicWrite?: boolean;
}

/**
 * dev/prod 共用的逐文件 TypeScript 编译实现
 *
 * 每个 `.ts` 独立编译为 `.js`，不分析 import 关系（`bundle: false`——
 * 保证 config 与 routes 共享同一运行时对象，`instanceof` 跨边界生效）。
 * 产物**打平 src/ 前缀**：`src/api/hello/handler.ts` → `<dist>/api/hello/handler.js`。
 *
 * 别名在编译时重写为相对路径，运行时无需 loader。
 *
 * 通过 `compileDevRoutes` / `compileBuildRoutes` 调用，见 ./compileSourceFiles.md
 * 的选项矩阵。
 */
export async function compileSourceFiles(
  options: CompileSourceFilesOptions,
): Promise<CompileResult> {
  const { rootDir, dist, files, logLevel = 'silent', production, atomicWrite } = options;

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
    // build 语义：编译期 NODE_ENV 替换 + 死分支删除（见 AGENTS.md §5.3）
    ...(production
      ? { define: { 'process.env.NODE_ENV': '"production"' }, minifySyntax: true }
      : {}),
    logLevel,
    // dev 语义：esbuild 返回内存内容，由下方原子写落盘
    ...(atomicWrite ? { write: false as const } : {}),
  });

  // 原子写：逐个写临时文件 + rename。rename 在同一文件系统上是原子的（POSIX），
  // HTTP 请求要么看到旧文件要么看到新文件
  if (atomicWrite && result.outputFiles) {
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
 * 全量扫描 src 下的 .ts 文件（排除测试文件和声明文件）
 *
 * 与 compileSourceFiles 的全量分支使用同一 ignore 规则，供 watch 等场景独立扫描。
 */
export async function collectSourceFiles(rootDir: string): Promise<string[]> {
  return fg([`${APP_DIR}/**/*.ts`], {
    cwd: rootDir,
    onlyFiles: true,
    absolute: true,
    ignore: ['**/*.test.ts', '**/*.e2e.test.ts', '**/*.d.ts'],
  });
}
