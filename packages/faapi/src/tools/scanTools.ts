import fg from 'fast-glob';
import path from 'node:path';
import fs from 'node:fs';
import type { ToolManifestList } from './toolTypes';
import { LLM_TOOL_NAME_PATTERN } from '../injection/subAgentToolName';

/**
 * tool 扫描 patterns（框架约定，非用户可配置项）
 *
 * 与路由的 src/api 扫描对称——tool 文件约定放在 `src/tools` 下任意层级子目录的 handler.ts。
 * 所有 tool 都是共享的，agent 通过 config 块的 `tools` 字段显式声明引用哪些。
 */
export const TOOL_PATTERNS = ['src/tools/**/*.ts'];

/**
 * 匹配源码中导出的函数名（任意合法标识符，区别于路由的固定 HTTP 方法名）
 *
 * 支持：
 * - `export function getWeather(input) {}`
 * - `export async function getWeather(input) {}`
 * - `export const getWeather = (input) => {}`
 * - `export const getWeather = async (input) => {}`
 *
 * 不匹配：
 * - `export interface WeatherInput {}`（interface 关键字）
 * - `export type X = ...`（type 关键字）
 * - `export { getWeather }`（命名导出引用，非声明）
 * - `export default function ...`（default 后非 function/const）
 *
 * 不通过运行时 import 提取函数名，避免启动时全量加载 tool 模块（Vite 风格：
 * tool 发现与 tool.js 加载解耦，tool.js 按需编译/导入）。
 */
const TOOL_EXPORT_RE = new RegExp(
  String.raw`export\s+(?:async\s+)?(?:function\s+|const\s+)([A-Za-z_$][\w$]*)\s*(?:\(|=)`,
  'g',
);

/**
 * 保留导出名（即使匹配正则也不识别为 tool）
 *
 * - `default` — 默认导出保留
 * - `config` — agent 配置块（scanAgents 使用）
 * - `run` — agent 自定义运行函数（scanAgents 使用）
 */
const RESERVED_EXPORTS = new Set(['default', 'config', 'run']);

/**
 * 从源码内容中提取所有 tool 函数导出名（去重 + 排除保留名）
 */
function extractToolExportsFromSource(source: string): Set<string> {
  const names = new Set<string>();
  let match: RegExpExecArray | null;
  TOOL_EXPORT_RE.lastIndex = 0;
  while ((match = TOOL_EXPORT_RE.exec(source)) !== null) {
    const name = match[1]!;
    if (!RESERVED_EXPORTS.has(name)) {
      names.add(name);
    }
  }
  return names;
}

/**
 * tool 目录段合法字符——与 agent 目录段同规则（[scanAgents](../agents/scanAgents.ts)）：
 * LLM 工具名字符集（`[a-zA-Z0-9_-]`，OpenAI 兼容协议对 function.name 的硬约束）再排除
 * `_`——`_` 被 `/` 规范化独占为嵌套分隔符（段内出现会让「嵌套」与「段内下划线」不可
 * 区分），`.` 等其余字符进入 tool 名后会被强校验上游（DeepSeek / OpenAI 等）整单 400
 */
const TOOL_DIR_SEGMENT_PATTERN = /^[a-zA-Z0-9-]+$/;

/**
 * 从相对路径（已剥离前缀）提取命名空间
 *
 * weather/handler.ts → 'weather'
 * handler.ts → ''
 * a/b/handler.ts → 'a_b'
 *
 * 目录段含非法字符时抛错（含路径与改名指引），不静默净化——非法名字发给强校验
 * 上游整单 400，且静默改名会掩盖配置错误。
 */
function extractNamespaceFromRelPath(relPath: string): string {
  const lastSlash = relPath.lastIndexOf('/');
  const dirPath = lastSlash === -1 ? '' : relPath.slice(0, lastSlash);
  if (!dirPath) return '';
  const segments = dirPath.split('/');
  for (const segment of segments) {
    if (!TOOL_DIR_SEGMENT_PATTERN.test(segment)) {
      throw new Error(
        `Invalid tool directory segment "${segment}" in "tools/${relPath}": ` +
          `tool directory names allow a-z A-Z 0-9 '-' only ('_' is reserved as the nesting separator, ` +
          `'.' is not allowed — tool names are sent to LLMs as function.name) — rename the directory`,
      );
    }
  }
  return segments.join('_');
}

/**
 * 从文件路径生成 tool 命名空间（子目录，用 _ 连接，不含函数名）
 *
 * 命名空间生成规则：
 * 1. 剥离 `tools/` 前缀（找第一个 `tools/`）
 * 2. 剥离文件名（handler.ts）
 * 3. 剩余路径段用 `_` 连接
 *
 * 例子：
 * - src/tools/weather/handler.ts → 'weather'
 * - src/tools/handler.ts → ''
 * - src/tools/a/b/handler.ts → 'a_b'
 */
function filePathToToolNamespace(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');

  // 剥离 tools/ 前缀（找第一个 tools/）
  const toolsMatch = normalized.match(/(?:^|\/)tools\/(.+)$/);
  if (toolsMatch) {
    return extractNamespaceFromRelPath(toolsMatch[1]!);
  }

  // 不在 tools/ 下，返回空（不应发生）
  return '';
}

/**
 * 生成 tool 名：命名空间_函数名 或 纯函数名
 *
 * 合成名整体须满足 LLM 工具名字符集——函数名含 `$` 等非法字符时抛错（改名或用
 * `@tool` JSDoc 覆盖），不静默净化
 */
function buildToolName(namespace: string, functionName: string): string {
  const name = namespace ? `${namespace}_${functionName}` : functionName;
  if (!LLM_TOOL_NAME_PATTERN.test(name)) {
    throw new Error(
      `Tool name "${name}" (function "${functionName}"${namespace ? ` in namespace "${namespace}"` : ''}) ` +
        `violates the LLM tool name pattern ${LLM_TOOL_NAME_PATTERN} — ` +
        `rename the function or use a @tool JSDoc override (allowed: a-z A-Z 0-9 '-' '_')`,
    );
  }
  return name;
}

/**
 * 扫描 tools 目录，生成 tool 清单
 *
 * Vite 风格：启动时只读源码 + 正则提取函数导出名，不 import tool.js。
 * tool.js 加载延后到 loadToolModule 请求阶段（详见 compileOnDemand）。
 *
 * tool 文件格式：handler.ts，导出任意函数即声明一个 tool（一个文件可多个）。
 * 排除保留导出名：default / config / run（agent 系统保留）。
 *
 * 所有 tool 都是共享的——放在 `src/tools` 下任意层级子目录的 handler.ts。
 * agent 通过 config 块的 `tools` 字段显式声明引用哪些 tool。
 *
 * tool 命名规则：子目录_函数名（如 weather_getWeather，段间与命名空间-函数名都用 `_`
 * 连接），无子目录时纯函数名；目录段与合成名走字符集校验（见上方常量与 buildToolName）。
 *
 * 重名检测：同名 tool 抛错。
 *
 * @param rootDir 项目根目录
 * @param patterns glob patterns（源码 .ts 路径，匹配 src/tools 下 tool 文件）
 */
export async function scanTools(rootDir: string, patterns: string[]): Promise<ToolManifestList> {
  const files = await fg(patterns, {
    cwd: rootDir,
    onlyFiles: true,
    absolute: false,
  });

  const tools: ToolManifestList = [];
  // 重名检测：toolName → filePath
  const seen = new Map<string, string>();

  for (const file of files) {
    const normalizedFile = file.replace(/\\/g, '/');
    const fileName = normalizedFile.split('/').pop()!;

    // 只处理 handler.ts（与路由 handler.ts 对称），其他 .ts 文件跳过
    if (fileName !== 'handler.ts' && fileName !== 'handler.js') {
      continue;
    }

    const absPath = path.resolve(rootDir, normalizedFile);
    const source = await fs.promises.readFile(absPath, 'utf8').catch(() => '');
    const exportNames = extractToolExportsFromSource(source);

    const namespace = filePathToToolNamespace(normalizedFile);

    for (const fnName of exportNames) {
      const toolName = buildToolName(namespace, fnName);

      // 重名检测：同名 tool 报错
      const prevFile = seen.get(toolName);
      if (prevFile) {
        throw new Error(
          `Tool conflict: "${toolName}" declared in both ${prevFile} and ${normalizedFile}`,
        );
      }

      seen.set(toolName, normalizedFile);

      tools.push({
        name: toolName,
        functionName: fnName,
        filePath: normalizedFile,
      });
    }
  }

  return tools;
}
