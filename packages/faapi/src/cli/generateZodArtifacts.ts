import path from 'node:path';
import { existsSync } from 'node:fs';
import { atomicWriteFile } from '../utils/atomicWrite';
import type { RuntimeType } from '../ast/resolveTypeNode';
import {
  generateHelpersFileSource,
  usesCoerceHelpers,
  HELPERS_FILENAME,
} from '../ast/generateZodSchema';
import { getSchemaOutputPath, getHelpersImportPath } from './generateSchemaFiles';

/**
 * zod.js 产物生成的共享管线
 *
 * routes / tools / tasks 三条产物管线的「分组 → 算 helpers import 路径 → 生成
 * 源码 → 按需生成 faapi-helpers.js → 并行原子写」流程完全同构，此前三处复制粘贴
 * （新增字段或 coerce 语义变化需同步改三处）。本模块把差异项（每个 source 的
 * 文件路径、按文件生成源码的回调）抽为参数，流程只此一份。
 *
 * 产物布局约定（与 getSchemaOutputPath 一致）：源文件剥 src/ 前缀后同级目录写
 * zod.js，faapi-helpers.js 固定在 dist 根部。
 */

/** 管线输入的单条 schema 源（与 RouteSchemaSource/ToolSchemaSource/TaskSchemaSource 的公共面） */
export interface ZodArtifactSource {
  /** 源文件绝对路径（分组键 + 输出路径推导） */
  filePath: string;
}

export interface GenerateZodArtifactsOptions<T extends ZodArtifactSource> {
  /** 同一文件的 schema 源列表 → 该文件 zod.js 源码 */
  generateFileSource: (
    fileSources: T[],
    resolveType: (name: string) => RuntimeType | undefined,
    helpersImportPath: string,
  ) => string;
  /** 文件绝对路径 → 惰性类型解析器（解析 ref） */
  resolversByFile: Map<string, { resolve(name: string): { runtimeType: RuntimeType } | null }>;
  rootDir: string;
  dist: string;
}

/**
 * 生成 zod.js 产物集（含按需的 faapi-helpers.js）
 *
 * helpers 生成条件：任一 zod.js 源码引用 coerce 函数。helpers.js 已存在时跳过
 * （三条管线共享同一份，先到的生成）。全部文件并行原子写——dev watch 重建与在途
 * 请求并发时，请求侧 import 不到半成品。
 */
export async function generateZodArtifacts<T extends ZodArtifactSource>(
  sources: T[],
  options: GenerateZodArtifactsOptions<T>,
): Promise<void> {
  const { generateFileSource, resolversByFile, rootDir, dist } = options;
  if (sources.length === 0) return;

  // 按源文件分组（同一 handler.ts 的多个方法合并到一个 zod.js）
  const sourcesByFile = new Map<string, T[]>();
  for (const source of sources) {
    let list = sourcesByFile.get(source.filePath);
    if (!list) {
      list = [];
      sourcesByFile.set(source.filePath, list);
    }
    list.push(source);
  }

  // 每文件生成源码（先暂存，helpers 检测需要全部源码）
  const fileEntries: { outputPath: string; source: string }[] = [];
  for (const [filePath, fileSources] of sourcesByFile) {
    const relFile = path.relative(rootDir, filePath).replace(/\\/g, '/');
    const outputPath = getSchemaOutputPath(relFile, dist, rootDir);
    const resolver = resolversByFile.get(filePath);

    // zod.js 所在目录相对 dist 的路径（helpers import 相对路径推导）：
    // strip src/ 前缀后取目录部分，与 getSchemaOutputPath 的目录推导一致
    let relForDir = relFile;
    if (relForDir.startsWith('src/')) {
      relForDir = relForDir.slice(4);
    }
    const dirIdx = relForDir.lastIndexOf('/');
    const zodRelDir = dirIdx >= 0 ? relForDir.slice(0, dirIdx) : '';

    const source = generateFileSource(
      fileSources,
      (name) => resolver?.resolve(name)?.runtimeType,
      getHelpersImportPath(zodRelDir),
    );
    fileEntries.push({ outputPath, source });
  }

  // 按需生成 faapi-helpers.js（已存在跳过——三条管线共享同一份）
  const allSourceCode = fileEntries.map((e) => e.source).join('\n');
  if (usesCoerceHelpers(allSourceCode)) {
    const helpersPath = path.resolve(rootDir, dist, HELPERS_FILENAME);
    if (!existsSync(helpersPath)) {
      await atomicWriteFile(helpersPath, generateHelpersFileSource());
    }
  }

  // 并行原子写所有 zod.js
  await Promise.all(
    fileEntries.map(({ outputPath, source }) => atomicWriteFile(outputPath, source)),
  );
}
