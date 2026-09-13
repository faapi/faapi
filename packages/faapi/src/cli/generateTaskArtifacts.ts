import path from 'node:path';
import type { TaskManifest, TaskMetadata } from '../task/taskTypes';
import { extractToolMetadata, type ToolMetadata } from '../ast/extractToolMetadata';
import { createPrograms } from '../ast/createProgram';
import { toProdFilePath } from '../utils/prodPaths';
import { atomicWriteFile } from '../utils/atomicWrite';
import { getSchemaOutputPath, getHelpersImportPath } from './generateSchemaFiles';
import {
  extractTypeInfo,
  createLazyTypeResolver,
  type HandlerTypeInfo,
  type LazyTypeResolver,
} from '../ast/extractHandlerTypes';
import type { RuntimeType } from '../ast/resolveTypeNode';
import {
  generateZodSchemaSource,
  generateHelpersFileSource,
  usesCoerceHelpers,
  HELPERS_FILENAME,
} from '../ast/generateZodSchema';

/**
 * faapi-tasks.js 文件名（与 faapi-routes.js / faapi-tools.js 同构）
 */
export const TASKS_FILE = 'faapi-tasks.js';

/**
 * 序列化的 task manifest 记录（可写入 JS 模块，无函数引用）
 *
 * 与 TaskMetadata 字段一一对应，仅 `filePath` 由源码形式（`src/tasks/...`）转为
 * 产物形式（`<dist>/tasks/...`，打平 src/ 前缀）。`undefined` 字段在
 * JSON.stringify 时自动省略，水合时通过 `??` 兜底。
 */
export interface SerializedTaskRecord {
  name: string;
  /** 产物路径（如 `dist/tasks/send-email/task.js`），运行时 import 任务模块 */
  filePath: string;
  cron?: string;
  concurrency?: number;
  retries?: number;
}

/**
 * 序列化任务清单为可写入 JS 模块的结构
 */
export function serializeTasks(
  tasks: TaskManifest[],
  dist: string = 'dist',
): SerializedTaskRecord[] {
  return tasks.map((t) => ({
    name: t.name,
    filePath: toProdFilePath(t.filePath, dist),
    ...(t.cron !== undefined ? { cron: t.cron } : {}),
    ...(t.concurrency !== undefined ? { concurrency: t.concurrency } : {}),
    ...(t.retries !== undefined ? { retries: t.retries } : {}),
  }));
}

/**
 * 把序列化任务清单写入 faapi-tasks.js（与 writeToolsModule 同构）
 */
export async function writeTasksModule(
  manifest: SerializedTaskRecord[],
  outputPath: string,
): Promise<void> {
  const content = `// 自动生成,请勿手动编辑(faapi build/dev 产物)
export const tasks = ${JSON.stringify(manifest, null, 2)};
`;
  await atomicWriteFile(outputPath, content);
}

/**
 * 从序列化清单水合还原 TaskMetadata[]
 */
export function hydrateTasks(manifest: SerializedTaskRecord[]): TaskMetadata[] {
  return manifest.map((t) => ({
    name: t.name,
    filePath: t.filePath,
    cron: t.cron ?? undefined,
    concurrency: t.concurrency ?? undefined,
    retries: t.retries ?? undefined,
  }));
}

/**
 * 单个任务的 schema 提取结果（与 ToolSchemaSource 同构，复用 tool 的 zod 生成管线）
 */
interface TaskSchemaSource {
  name: string;
  filePath: string;
  /** schema 名 = run 首参类型名（如 `Payload`，导出 `${schemaName}Schema`） */
  schemaName: string;
  typeInfo: HandlerTypeInfo | null;
}

/**
 * 从任务元数据收集 schema 提取所需数据（按文件分组，共享 TS Program）
 *
 * 与 generateToolArtifacts 的 collectToolSchemaSources 对称，但提取的函数固定为 `run`。
 * run 首参无类型名（无 Payload interface）的任务被跳过——运行时同样跳过校验。
 */
function collectTaskSchemaSources(
  tasks: Array<ToolMetadata & { taskName: string }>,
  rootDir: string,
): {
  sources: TaskSchemaSource[];
  resolversByFile: Map<string, LazyTypeResolver>;
} {
  const tasksByFile = new Map<string, Array<ToolMetadata & { taskName: string }>>();
  for (const task of tasks) {
    if (!task.inputTypeName) continue;
    const absPath = path.resolve(rootDir, task.filePath);
    let list = tasksByFile.get(absPath);
    if (!list) {
      list = [];
      tasksByFile.set(absPath, list);
    }
    list.push(task);
  }

  const programByFile = createPrograms([...tasksByFile.keys()]);
  const resolversByFile = new Map<string, LazyTypeResolver>();
  for (const filePath of tasksByFile.keys()) {
    resolversByFile.set(filePath, createLazyTypeResolver(programByFile.get(filePath)!, filePath));
  }

  const sources: TaskSchemaSource[] = [];
  for (const [filePath, fileTasks] of tasksByFile) {
    const program = programByFile.get(filePath)!;
    for (const task of fileTasks) {
      const typeInfo = extractTypeInfo(program, filePath, task.inputTypeName!);
      sources.push({
        name: task.taskName,
        filePath,
        schemaName: task.inputTypeName!,
        typeInfo,
      });
    }
  }

  return { sources, resolversByFile };
}

/**
 * 生成单个任务 zod.js 源码（复用 generateToolSchemaFileSource，coerce=false）
 */
function generateTaskSchemaFileSource(
  sources: TaskSchemaSource[],
  resolveType: (name: string) => RuntimeType | undefined,
  helpersImportPath: string,
): string {
  const lines: string[] = ["import { z } from 'zod';"];
  const schemaBlocks: string[] = [];
  for (const source of sources) {
    if (!source.typeInfo) continue;
    const block = [`// task ${source.name} → ${source.schemaName}`];
    const schemaCode = generateZodSchemaSource(
      source.typeInfo,
      resolveType,
      source.schemaName,
      false,
    ).replace(/^import \{ z \} from 'zod';\s*\n\s*\n/, '');
    block.push(schemaCode);
    block.push('');
    schemaBlocks.push(block.join('\n'));
  }

  const allSchemaCode = schemaBlocks.join('\n');
  if (helpersImportPath && usesCoerceHelpers(allSchemaCode)) {
    lines.push(
      `import { coerceNumber, coerceBoolean, coerceMap, coerceSet } from '${helpersImportPath}';`,
    );
  }
  lines.push('');
  lines.push(...schemaBlocks);
  return lines.join('\n').replace(/\n+$/, '\n');
}

/**
 * 主入口：生成 faapi-tasks.js 任务清单 + 各任务的 zod.js
 *
 * dev/prod 行为一致（全量生成）：任务文件数量小，且任务在队列派发时 import
 * 模块——不像 HTTP 请求能把按需编译的失败反馈给调用方，故 dev 不做按需。
 *
 * @param manifests scanTasks 产出的 TaskManifest[]
 * @param rootDir 项目根目录
 * @param dist 产物目录（`.faapi` 或 `dist`）
 * @returns 序列化后的 TaskMetadata[]（供调用方日志/直接水合）
 */
export async function generateTaskArtifacts(
  manifests: TaskManifest[],
  rootDir: string,
  dist: string,
): Promise<TaskMetadata[]> {
  // 1. AST 增强：提取 run 首参类型名（Payload schema 用）
  const metadata: Array<ToolMetadata & { taskName: string }> = [];
  if (manifests.length > 0) {
    const programByFile = createPrograms(manifests.map((m) => path.resolve(rootDir, m.filePath)));
    for (const manifest of manifests) {
      const absPath = path.resolve(rootDir, manifest.filePath);
      const result = extractToolMetadata(programByFile.get(absPath)!, absPath, 'run', {
        name: manifest.name,
        filePath: manifest.filePath,
      });
      if (result) {
        metadata.push({ ...result, taskName: manifest.name });
      }
    }
  }

  // 2. 序列化 + 写入 faapi-tasks.js（无任务时写空清单，运行时空转）
  const serialized = serializeTasks(manifests, dist);
  const tasksPath = path.resolve(rootDir, dist, TASKS_FILE);
  await writeTasksModule(serialized, tasksPath);

  // 3. 生成 zod.js（无 Payload 类型的任务跳过）
  if (metadata.length === 0) {
    return hydrateTasks(serialized);
  }

  const { sources, resolversByFile } = collectTaskSchemaSources(metadata, rootDir);
  if (sources.length === 0) {
    return hydrateTasks(serialized);
  }

  const sourcesByFile = new Map<string, TaskSchemaSource[]>();
  for (const source of sources) {
    let list = sourcesByFile.get(source.filePath);
    if (!list) {
      list = [];
      sourcesByFile.set(source.filePath, list);
    }
    list.push(source);
  }

  const fileEntries: { outputPath: string; source: string }[] = [];
  for (const [filePath, fileSources] of sourcesByFile) {
    const relFile = path.relative(rootDir, filePath).replace(/\\/g, '/');
    const outputPath = getSchemaOutputPath(relFile, dist, rootDir);
    const resolver = resolversByFile.get(filePath);

    let relForDir = relFile;
    if (relForDir.startsWith('src/')) {
      relForDir = relForDir.slice(4);
    }
    const dirIdx = relForDir.lastIndexOf('/');
    const zodRelDir = dirIdx >= 0 ? relForDir.slice(0, dirIdx) : '';
    const helpersImportPath = getHelpersImportPath(zodRelDir);

    const source = generateTaskSchemaFileSource(
      fileSources,
      (name) => resolver?.resolve(name)?.runtimeType,
      helpersImportPath,
    );
    fileEntries.push({ outputPath, source });
  }

  // 4. 检测并生成/复用 faapi-helpers.js（Map/Set 字段需要，与路由/tool 共享一份）
  const allSourceCode = fileEntries.map((e) => e.source).join('\n');
  if (usesCoerceHelpers(allSourceCode)) {
    const helpersPath = path.resolve(rootDir, dist, HELPERS_FILENAME);
    const { existsSync } = await import('node:fs');
    if (!existsSync(helpersPath)) {
      await atomicWriteFile(helpersPath, generateHelpersFileSource());
    }
  }

  await Promise.all(
    fileEntries.map(({ outputPath, source }) => atomicWriteFile(outputPath, source)),
  );

  return hydrateTasks(serialized);
}
