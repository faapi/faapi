import ts from 'typescript';
import {
  extractDescription,
  extractJSDocTagValue,
  getJSDocFromNode,
  hasExportModifier,
} from './jsDocMetadata';

/**
 * Tool 的 LLM 可见核心字段
 *
 * 描述"tool 是什么"——LLM 真正需要消费的字段(发往 LLM 的 tool 定义只含
 * `name` / `description` / input schema),**不含**代码本体加载细节
 * (`filePath` / `functionName` / `inputTypeName`)。
 *
 * 与 [AgentCore](./extractAgentMetadata.md) 对称——LLM-facing 字段与代码加载
 * 细节分离,便于未来扩展(如 DB-driven tool 只实现 `ToolCore` 即可)。
 *
 * `toolRegistry` 查询入口 / `@faapi/agent` 子包的 `buildToolDefinitions`
 * 都消费 `ToolCore` 字段组装 LLM tool 列表。
 */
export interface ToolCore {
  /** tool 名(`@tool` JSDoc 覆盖值 或 路径推导值) */
  name: string;
  /** JSDoc 描述(tool 描述,对 LLM 可见),无 JSDoc 或 JSDoc 无自由文本时为 `undefined` */
  description?: string;
}

/**
 * Tool 完整元数据(文件型 tool)
 *
 * 继承 [ToolCore](./extractToolMetadata.md) 的 LLM 字段,额外扩展**代码本体加载细节**:
 * - `filePath` — `loadToolModule` 加载 `handler.js` 产物定位函数用
 * - `functionName` — 源码导出函数名(不受 `@tool` 覆盖影响,AST 定位 + 运行时 resolveExport 用)
 * - `inputTypeName` — 第一个参数的 TypeReference 名(供 [extractTypeInfo](./extractHandlerTypes.md)
 *   生成 zod schema;运行时 `resolveToolSchema` 据此定位 `zod.js`)
 *
 * 由 [extractToolMetadata](./extractToolMetadata.md) 产出,合并路径推导字段
 * (来自 [scanTools](../tools/scanTools.md) 的 `ToolManifest`)与 AST 提取字段
 * (JSDoc 描述、`@tool` 覆盖名、第一个参数 interface 名)。
 *
 * 字段来源:
 * - `name` — `@tool` JSDoc 覆盖值,或 `pathMeta.name`(路径推导)
 * - `description` — JSDoc 注释块自由文本(对 LLM 可见)
 * - `filePath` / `functionName` — 由 `pathMeta` 透传
 * - `inputTypeName` — 第一个参数的 TypeReference 名(供 [extractTypeInfo](./extractHandlerTypes.md) 生成 zod schema)
 */
export interface ToolMetadata extends ToolCore {
  /** 第一个参数的 interface/type 名(用于生成 zod schema),
   *  无参数/参数无类型标注/参数为内联类型字面量时为 `undefined` */
  inputTypeName?: string;
  /** 源码相对路径(从 `pathMeta` 透传) */
  filePath: string;
  /** 源码中的导出函数名(从 `pathMeta` 透传,AST 定位用,不受 `@tool` 覆盖影响) */
  functionName: string;
}

/**
 * 路径推导的 tool 元数据(由 [scanTools](../tools/scanTools.ts) 计算)
 *
 * 透传到 [ToolMetadata](./extractToolMetadata.ts) 输出,与 AST 提取字段合并。
 */
export interface ToolPathMeta {
  /** 路径推导的 tool 名(如 `weather.getWeather`) */
  name: string;
  /** 源码相对路径(如 `src/tools/weather/handler.ts`) */
  filePath: string;
}

/** 函数节点联合类型(FunctionDeclaration / ArrowFunction / FunctionExpression) */
type FunctionLike = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;

/**
 * 从 tool handler.ts 提取单个 tool 的元数据
 *
 * 提取内容:
 * 1. **JSDoc 描述** — 注释块自由文本(`@tag` 之前的首段),对 LLM 可见
 * 2. **`@tool` 覆盖名** — JSDoc 中 `@tool` 标签后的文本(如 `customName`),覆盖路径推导的 `name`
 * 3. **第一个参数 interface 名** — 供 [extractTypeInfo](./extractHandlerTypes.ts) 生成 zod schema
 *
 * 不提取(由 `pathMeta` 透传): `filePath` / `functionName`
 *
 * 函数查找支持四种导出形式,与 [scanTools](../tools/scanTools.ts) 的 `TOOL_EXPORT_RE` 正则同构:
 * - `export function name() {}`
 * - `export async function name() {}`
 * - `export const name = () => {}`
 * - `export const name = async () => {}`(以及 `= function () {}`)
 *
 * JSDoc 查找对箭头函数/函数表达式自动回溯到外层 `VariableStatement`
 * (JSDoc 通常写在 `export const` 上方,而非箭头函数本身)。
 *
 * @param program TypeScript Program
 * @param filePath 源文件**绝对路径**(AST 用,需与 `program.getSourceFile` 一致)
 * @param functionName 源码导出函数名(在文件中查找的目标)
 * @param pathMeta 路径推导的元数据(scanTools 已计算)
 * @returns `ToolMetadata` 或 `null`(函数未找到或源文件不在 Program 中)
 */
export function extractToolMetadata(
  program: ts.Program,
  filePath: string,
  functionName: string,
  pathMeta: ToolPathMeta,
): ToolMetadata | null {
  const sourceFile = program.getSourceFile(filePath);
  if (!sourceFile) return null;

  const found = findExportedFunction(sourceFile, functionName);
  if (!found) return null;

  const { fn, jsDocOwner } = found;
  const jsDoc = getJSDocFromNode(jsDocOwner);
  const description = extractDescription(jsDoc);
  const toolNameOverride = extractJSDocTagValue(jsDoc, 'tool');
  const inputTypeName = getFirstParamTypeName(fn, sourceFile);

  return {
    name: toolNameOverride ?? pathMeta.name,
    description,
    inputTypeName,
    filePath: pathMeta.filePath,
    functionName,
  };
}

/** 函数查找结果:函数节点 + JSDoc 持有节点 */
interface FoundFunction {
  /** 函数节点(FunctionDeclaration / ArrowFunction / FunctionExpression) */
  fn: FunctionLike;
  /** JSDoc 持有节点(FunctionDeclaration 时为函数本身;箭头/函数表达式时为外层 VariableStatement) */
  jsDocOwner: ts.Node;
}

/**
 * 在源文件中查找指定名称的导出函数
 *
 * 遍历顶层节点,匹配四种导出形式。返回函数节点和 JSDoc 持有节点:
 * - `export function name` → 两者都是 FunctionDeclaration 本身
 * - `export const name = () => {}` → fn 是 ArrowFunction,jsDocOwner 是外层 VariableStatement
 *   (JSDoc 通常写在 `export const` 上方,而非箭头函数本身)
 *
 * 不依赖 `node.parent` 链——`ts.createProgram` 配置 `noEmit: true` 时不会设置父指针,
 * 故改在遍历时直接绑定 JSDoc 持有节点。
 *
 * 非 export 的同名函数不被识别。
 */
function findExportedFunction(
  sourceFile: ts.SourceFile,
  functionName: string,
): FoundFunction | null {
  let result: FoundFunction | null = null;

  ts.forEachChild(sourceFile, (node) => {
    if (result) return;

    // export function name() {} / export async function name() {}
    if (
      ts.isFunctionDeclaration(node) &&
      hasExportModifier(node) &&
      node.name?.text === functionName
    ) {
      result = { fn: node, jsDocOwner: node };
      return;
    }

    // export const name = () => {} / export const name = function () {}
    if (ts.isVariableStatement(node) && hasExportModifier(node)) {
      for (const decl of node.declarationList.declarations) {
        if (result) break;
        const nameText = ts.isIdentifier(decl.name)
          ? decl.name.text
          : decl.name.getText(sourceFile);
        if (nameText !== functionName || !decl.initializer) continue;
        if (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)) {
          // JSDoc 通常在 VariableStatement 上(写在 `export const` 上方)
          result = { fn: decl.initializer, jsDocOwner: node };
        }
      }
    }
  });

  return result;
}

/**
 * 提取第一个参数的 interface/type 名(TypeReference)
 *
 * - 参数有 TypeReference 类型标注(如 `input: WeatherInput`)→ `'WeatherInput'`
 * - 参数无类型标注 / 内联类型字面量(如 `input: { city: string }`)→ `undefined`
 * - 函数无参数 → `undefined`
 * - 多参数时取第一个参数的类型名
 *
 * 返回 `undefined` 而非抛错——tool 允许无参数输入或无 schema 校验,
 * 是否生成 `zod.js` 由下游 `generateToolArtifacts` 根据 `inputTypeName` 是否为 `undefined` 决定。
 */
function getFirstParamTypeName(fn: FunctionLike, sourceFile: ts.SourceFile): string | undefined {
  const firstParam = fn.parameters[0];
  if (!firstParam) return undefined;
  if (!firstParam.type) return undefined;
  if (!ts.isTypeReferenceNode(firstParam.type)) return undefined;
  return firstParam.type.typeName.getText(sourceFile);
}
