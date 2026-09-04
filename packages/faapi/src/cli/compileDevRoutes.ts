import { compileSourceFiles, collectSourceFiles, type CompileResult } from './compileSourceFiles';

export { collectSourceFiles };
export type { CompileResult };

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
 * dev 模式编译 TypeScript：逐文件编译，启动快、增量编译友好
 *
 * 共享实现见 [compileSourceFiles](./compileSourceFiles.ts)；dev 差异仅两点：
 * 不传 `define`（`process.env.NODE_ENV` 运行时读取环境变量，便于热替换）+
 * **原子写**（写临时文件 + rename，避免 watch 模式下运行时 import 读到半成品产物，
 * 详见 compileDevRoutes.md 的"dev 原子写"章节）。
 *
 * @example
 * // 全量编译
 * await compileDevRoutes({ rootDir, dist: '.faapi' });
 * // watch 增量：只编译变化的文件
 * await compileDevRoutes({ rootDir, dist: '.faapi', files: changedFiles });
 */
export async function compileDevRoutes(options: CompileDevOptions): Promise<CompileResult> {
  return compileSourceFiles({ ...options, atomicWrite: true });
}
