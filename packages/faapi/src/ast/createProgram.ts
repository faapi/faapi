import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Program 缓存，key 为入口文件路径
 *
 * watch 模式下通过 invalidateProgramCache() 全量清理。
 * 同一文件多次创建 Program 时复用缓存，避免重复解析。
 */
const programCache = new Map<string, ts.Program>();

/**
 * tsconfig 解析结果缓存，key 为 tsconfig.json 绝对路径
 *
 * 同一 tsconfig 下多个文件共享解析结果，避免每个文件都读盘 + parse。
 * invalidateProgramCache() 同时清空此缓存。
 */
interface TsConfigResult {
  /** parseJsonConfigFileContent 解析得到的 module 选项 */
  module?: ts.ModuleKind;
  /** parseJsonConfigFileContent 解析得到的 moduleResolution 选项 */
  moduleResolution?: ts.ModuleResolutionKind;
  /** tsconfig include 模式匹配的所有 .ts 文件绝对路径(作为 program rootNames) */
  fileNames: string[];
}
const tsConfigCache = new Map<string, TsConfigResult>();

/**
 * 清理所有 Program 缓存 + tsconfig 解析缓存（watch 模式下文件变化时调用）
 *
 * 全量清理而非增量清理，理由：
 * - 简单可靠，无状态一致性问题
 * - 跨文件类型引用需要所有文件的 Program 同步更新
 * - tsconfig 可能变化，需重新读取
 * - dev 模式文件量有限，全量重建在百毫秒级
 */
export function invalidateProgramCache(): void {
  programCache.clear();
  tsConfigCache.clear();
}

/**
 * 从指定文件路径向上查找最近的 tsconfig.json
 *
 * 从 filePath 所在目录开始逐级向上，返回第一个找到的 tsconfig.json 绝对路径。
 * 找不到返回 null（如 os.tmpdir() 测试场景）。
 */
function findTsConfig(filePath: string): string | null {
  let dir = path.dirname(filePath);
  const root = path.parse(dir).root;
  while (true) {
    const candidate = path.join(dir, 'tsconfig.json');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    if (dir === root) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * 解析 tsconfig.json，提取 module / moduleResolution / fileNames
 *
 * 使用 ts.readConfigFile 读取 + ts.parseJsonConfigFileContent 解析。
 * 保留 tsconfig 原始的 include/exclude/files 配置，让 ts 自动扫描所有相关 .ts 文件
 * 作为 program 的 rootNames——这样跨文件 import 的源文件会被加载到 program 中，
 * 使 resolveTypeReference 的兜底遍历（找同名声明）能成功。
 *
 * 只提取 module / moduleResolution 两个 compilerOptions 覆盖默认值，其余字段
 * （target / strict / jsx / paths 等）用框架默认值，避免业务项目配置干扰 AST 提取。
 *
 * 解析失败（语法错误 / 缺字段）返回空 fileNames + 空选项，回退到默认 NodeNext，
 * 保证 build 不被 tsconfig 损坏阻塞。
 */
function parseTsConfig(tsconfigPath: string): TsConfigResult {
  const cached = tsConfigCache.get(tsconfigPath);
  if (cached) return cached;

  const result: TsConfigResult = { fileNames: [] };

  try {
    const configFile = ts.readConfigFile(tsconfigPath, (p) => fs.readFileSync(p, 'utf-8'));
    if (configFile.error) {
      tsConfigCache.set(tsconfigPath, result);
      return result;
    }

    const config = configFile.config ?? {};
    const basePath = path.dirname(tsconfigPath);

    // 保留 tsconfig 原始 include/exclude/files，让 ts 自动扫描 .ts 文件
    // 这些文件作为 program 的 rootNames，让跨文件 import 的源文件被加载进来
    const parsed = ts.parseJsonConfigFileContent(
      config,
      ts.sys,
      basePath,
      /* existingOptions */ undefined,
      tsconfigPath,
    );

    result.fileNames = parsed.fileNames;
    if (parsed.options.module !== undefined) {
      result.module = parsed.options.module;
    }
    if (parsed.options.moduleResolution !== undefined) {
      result.moduleResolution = parsed.options.moduleResolution;
    }
  } catch {
    // 任何异常都回退默认，保证 build 不被 tsconfig 阻塞
  }

  tsConfigCache.set(tsconfigPath, result);
  return result;
}

/**
 * 为指定文件创建 TypeScript Program（带缓存）
 *
 * 从 filePath 向上查找最近的 tsconfig.json：
 * - 找到：用 ts.parseJsonConfigFileContent 解析，取 module / moduleResolution
 *   覆盖默认值，同时取 parsed.fileNames 作为 program 的 rootNames（让跨文件
 *   import 的源文件被加载进 program）
 * - 找不到（如 os.tmpdir() 测试场景）：回退到默认 NodeNext，rootNames 仅包含 filePath
 *
 * 加载全部相关文件保证 `resolveTypeReference` 的兜底遍历（找同名声明）能成功，
 * 修复业务项目用 `moduleResolution: Bundler` + 无扩展名相对导入时跨文件
 * `import type` 解析失败的问题。
 *
 * 同一次生成中需要分析多个文件时用 {@link createPrograms}（按 tsconfig 分组共享
 * 同一个 Program），避免每个文件单独创建 Program 重复解析全项目源码。
 *
 * @param filePath 要分析的 .ts 文件绝对路径
 */
export function createProgram(filePath: string): ts.Program {
  const cached = programCache.get(filePath);
  if (cached) {
    return cached;
  }

  const program = buildProgram([filePath], findTsConfig(filePath));

  programCache.set(filePath, program);
  return program;
}

/**
 * 为多个文件创建 Program（按 tsconfig 分组共享，带缓存）
 *
 * 同一次批量提取（build 时生成 routes/tools/agents 产物）中，所有向上查找到
 * 同一个 tsconfig.json 的文件共用**同一个 Program**——rootNames 为
 * tsconfig fileNames ∪ 全部入口文件，跨文件类型解析语义与单文件 `createProgram`
 * 完全一致，但 N 个文件只创建 1 个 Program（原来每个文件都全量解析一遍项目源码，
 * 是 build 时间的最大单项开销）。
 *
 * 缓存 key 为 `shared::<tsconfigPath>::<排序后的文件列表>`：同一批次重复调用命中
 * 缓存；不同批次（rootNames 不同）各自创建。`invalidateProgramCache()` 同时清理
 * 共享缓存与单文件缓存。
 *
 * 向上查找不到 tsconfig.json 的文件（如 os.tmpdir() 测试场景）逐个回退到
 * {@link createProgram} 单文件行为，不参与共享。
 *
 * @param filePaths 要分析的 .ts 文件绝对路径列表（内部去重）
 * @returns filePath → Program 映射（包含全部请求文件）
 */
export function createPrograms(filePaths: string[]): Map<string, ts.Program> {
  const unique = [...new Set(filePaths)];
  const result = new Map<string, ts.Program>();

  // 按向上查找到的 tsconfig.json 分组（同组共享一个 Program）
  const groups = new Map<string, { tsconfigPath: string; files: string[] }>();
  const noTsconfigFiles: string[] = [];
  for (const filePath of unique) {
    const tsconfigPath = findTsConfig(filePath);
    if (!tsconfigPath) {
      noTsconfigFiles.push(filePath);
      continue;
    }
    const group = groups.get(tsconfigPath);
    if (group) {
      group.files.push(filePath);
    } else {
      groups.set(tsconfigPath, { tsconfigPath, files: [filePath] });
    }
  }

  for (const { tsconfigPath, files } of groups.values()) {
    const cacheKey = `shared::${tsconfigPath}::${[...files].sort().join('|')}`;
    let program = programCache.get(cacheKey);
    if (!program) {
      program = buildProgram(files, tsconfigPath);
      programCache.set(cacheKey, program);
    }
    for (const filePath of files) {
      result.set(filePath, program);
    }
  }

  // 无 tsconfig 的文件回退单文件行为（保持与 createProgram 一致）
  for (const filePath of noTsconfigFiles) {
    result.set(filePath, createProgram(filePath));
  }

  return result;
}

/**
 * 构建 Program：合并框架默认 options 与 tsconfig 的 module / moduleResolution，
 * rootNames = 入口文件 ∪ tsconfig fileNames
 *
 * 由 {@link createProgram}（单文件）和 {@link createPrograms}（批量共享）共用，
 * 保证两条路径的 Program 构建语义一致。
 */
function buildProgram(entryFiles: string[], tsconfigPath: string | null): ts.Program {
  // 默认选项：与项目历史行为一致（NodeNext），保证向后兼容
  const options: ts.CompilerOptions = {
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
    noEmit: true,
  };

  // rootNames 默认只包含入口文件；读 tsconfig 后扩展为全部相关文件
  const rootNames = [...entryFiles];

  if (tsconfigPath) {
    const tsOptions = parseTsConfig(tsconfigPath);
    if (tsOptions.module !== undefined) {
      options.module = tsOptions.module;
    }
    if (tsOptions.moduleResolution !== undefined) {
      options.moduleResolution = tsOptions.moduleResolution;
    }
    if (tsOptions.fileNames.length > 0) {
      // 确保入口文件在 rootNames 中（即使 tsconfig include 未覆盖到）
      for (const fileName of tsOptions.fileNames) {
        if (!rootNames.includes(fileName)) {
          rootNames.push(fileName);
        }
      }
    }
  }

  return ts.createProgram(rootNames, options);
}
