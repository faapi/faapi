import ts from 'typescript';

/**
 * Program 缓存，key 为文件路径
 *
 * watch 模式下通过 invalidateProgramCache() 全量清理。
 * 同一文件多次创建 Program 时复用缓存，避免重复解析。
 */
const programCache = new Map<string, ts.Program>();

/**
 * 清理所有 Program 缓存（watch 模式下文件变化时调用）
 *
 * 全量清理而非增量清理，理由：
 * - 简单可靠，无状态一致性问题
 * - 跨文件类型引用需要所有文件的 Program 同步更新
 * - dev 模式文件量有限，全量重建在百毫秒级
 */
export function invalidateProgramCache(): void {
  programCache.clear();
}

/**
 * 为指定文件创建 TypeScript Program（带缓存）
 *
 * @param filePath 要分析的 .ts 文件绝对路径
 */
export function createProgram(filePath: string): ts.Program {
  const cached = programCache.get(filePath);
  if (cached) {
    return cached;
  }

  const program = ts.createProgram([filePath], {
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
    noEmit: true,
  });

  programCache.set(filePath, program);
  return program;
}
