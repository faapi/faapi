import { compileSourceFiles, type CompileResult } from './compileSourceFiles';

export type { CompileResult };

/**
 * build 编译选项
 */
export interface CompileBuildOptions {
  /** 项目根目录 */
  rootDir: string;
  /** 输出目录（build 模式为 `dist`） */
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
 * 共享实现见 [compileSourceFiles](./compileSourceFiles.ts)；build 差异仅一点：
 * 启用 `define` + `minifySyntax`，在编译期把 `process.env.NODE_ENV` 替换为
 * `"production"` 并删除 `if (false) {...}` 死分支。两者在 `bundle: false` 下均生效
 * （单文件级别优化，不需要跨文件分析）。
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
 * await compileBuildRoutes({ rootDir, dist: 'dist' });
 */
export async function compileBuildRoutes(options: CompileBuildOptions): Promise<CompileResult> {
  return compileSourceFiles({ ...options, production: true });
}
