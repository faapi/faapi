import ts from 'typescript';
import { extractDescription, getJSDocFromNode, hasExportModifier } from './jsDocMetadata';
import { SchemaExtractionError, findTopLevelDecl } from './resolveTypeNode';

/**
 * Tool 的 LLM 可见核心字段
 *
 * 描述"tool 是什么"——LLM 真正需要消费的字段(发往 LLM 的 tool 定义只含
 * `name` / `description` / input schema),**不含**代码本体加载细节
 * (`filePath` / `functionName` / `inputTypeName`)。
 *
 * 与 [AgentCore](../agents/agentTypes.md) 对称——LLM-facing 字段与代码加载
 * 细节分离,便于未来扩展(如 DB-driven tool 只实现 `ToolCore` 即可)。
 *
 * `toolRegistry` 查询入口 / `@faapi/agent` 子包的 `buildToolDefinitions`
 * 都消费 `ToolCore` 字段组装 LLM tool 列表。
 */
export interface ToolCore {
  /** tool 名(路径推导值:目录路径 + 函数名,嵌套段用 `_` 连接) */
  name: string;
  /** JSDoc 描述(tool 描述,对 LLM 可见),无 JSDoc 或 JSDoc 无自由文本时为 `undefined` */
  description?: string;
}

/**
 * Tool 完整元数据(文件型 tool)
 *
 * 继承 [ToolCore](./extractToolMetadata.md) 的 LLM 字段,额外扩展**代码本体加载细节**:
 * - `filePath` — `loadToolModule` 加载 `handler.js` 产物定位函数用
 * - `functionName` — 源码导出函数名(AST 定位 + 运行时 resolveExport 用)
 * - `inputTypeName` — 第一个参数的 TypeReference 名(供 [extractTypeInfo](./extractHandlerTypes.md)
 *   生成 zod schema;运行时 `resolveToolSchema` 据此定位 `zod.js`)
 *
 * 由 [extractToolMetadata](./extractToolMetadata.md) 产出,合并路径推导字段
 * (来自 [scanTools](../tools/scanTools.md) 的 `ToolManifest`)与 AST 提取字段
 * (JSDoc 描述、第一个参数 interface 名)。
 *
 * 字段来源:
 * - `name` — `pathMeta.name`(路径推导,嵌套段用 `_` 连接)
 * - `description` — JSDoc 注释块自由文本(对 LLM 可见)
 * - `filePath` / `functionName` — 由 `pathMeta` 透传
 * - `inputTypeName` — 第一个参数的 TypeReference 名(供 [extractTypeInfo](./extractHandlerTypes.md) 生成 zod schema)
 */
export interface ToolMetadata extends ToolCore {
  /** 第一个参数的 interface/type 名(用于生成 zod schema),
   *  无参数/参数无类型标注/参数为内联类型字面量时为 `undefined` */
  inputTypeName?: string;
  /** 第二个参数的业务校验类型名（用于生成 ctx schema,运行时声明即校验),
   *  无第二参/无类型标注/内联类型字面量/裸标注框架类型(`AgentToolContext`)时为 `undefined`;
   *  交叉类型(`OrderCtx & AgentToolContext`)拆分后取业务侧;命名别名指向含框架侧
   *  成员的交叉时解引用——唯一具名业务成员取业务名,否则默认名 = 别名名
   *  (由 extractCtxTypeInfo 剥离解析,见 getCtxSchemaTypeName 与 extractHandlerTypes.md) */
  ctxTypeName?: string;
  /** 源码相对路径(从 `pathMeta` 透传) */
  filePath: string;
  /** 源码中的导出函数名(从 `pathMeta` 透传,AST 定位用) */
  functionName: string;
}

/**
 * 路径推导的 tool 元数据(由 [scanTools](../tools/scanTools.ts) 计算)
 *
 * 透传到 [ToolMetadata](./extractToolMetadata.ts) 输出,与 AST 提取字段合并。
 */
export interface ToolPathMeta {
  /** 路径推导的 tool 名(如 `weather_getWeather`) */
  name: string;
  /** 源码相对路径(如 `src/tools/weather/handler.ts`) */
  filePath: string;
}

/** 函数节点联合类型(FunctionDeclaration / ArrowFunction / FunctionExpression) */
export type FunctionLike = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;

/**
 * 从 tool handler.ts 提取单个 tool 的元数据
 *
 * 提取内容:
 * 1. **JSDoc 描述** — 注释块自由文本(`@tag` 之前的首段),对 LLM 可见
 * 2. **第一个参数 interface 名** — 供 [extractTypeInfo](./extractHandlerTypes.ts) 生成 zod schema
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
  const inputTypeName = getFirstParamTypeName(fn, sourceFile);
  const ctxTypeName = getCtxSchemaTypeName(fn, sourceFile, program, functionName);

  return {
    name: pathMeta.name,
    description,
    inputTypeName,
    ctxTypeName,
    filePath: pathMeta.filePath,
    functionName,
  };
}

/** 函数查找结果:函数节点 + JSDoc 持有节点 */
export interface FoundFunction {
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
 *
 * extractHandlerTypes 的 extractCtxTypeInfo 内联回退（定位第二参标注）共用，故导出。
 */
export function findExportedFunction(
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
 * 提取第二个参数的类型名（TypeReference）
 *
 * 任务 run 的 ctx 类型标注校验用（generateTaskArtifacts）：task.ts 任务应标注
 * `TaskContext`、worker.ts 任务应标注 `IsolatedTaskContext`，标注与文件种类不符
 * 构建期报错。无第二参 / 无类型标注 / 非类型引用（内联字面量等）返回 `undefined`
 * ——ctx 可省略，未标注不做校验。
 */
export function getSecondParamTypeName(
  program: ts.Program,
  filePath: string,
  functionName: string,
): string | undefined {
  const sourceFile = program.getSourceFile(filePath);
  if (!sourceFile) return undefined;
  const found = findExportedFunction(sourceFile, functionName);
  if (!found) return undefined;
  const secondParam = found.fn.parameters[1];
  if (!secondParam?.type) return undefined;
  if (!ts.isTypeReferenceNode(secondParam.type)) return undefined;
  return secondParam.type.typeName.getText(sourceFile);
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

/**
 * ctx 交叉类型中框架侧的类型名——拆分时跳过（框架注入字段运行时恒有，非纯数据，不参与校验）
 *
 * extractHandlerTypes 的 extractCtxTypeInfo 剥离解析依赖同一口径，故导出。
 */
export const CTX_FRAMEWORK_TYPE_NAME = 'AgentToolContext';

/**
 * 提取第二个参数的业务校验类型名（tool ctx 声明即校验）
 *
 * 第二参合法形态与提取结果（语义详见 extractToolMetadata.md）：
 * - `ctx: OrderCtx` → `'OrderCtx'`
 * - `ctx: OrderCtx & AgentToolContext` → `'OrderCtx'`（唯一非框架侧成员且具名 → 业务名）
 * - `ctx: WriterToolContext` 且别名 = `WriterToolCtx & AgentToolContext` →
 *   `'WriterToolCtx'`（命名别名解引用——唯一具名业务成员取业务名，与标注层同路径）
 * - 业务侧无法唯一具名（多成员/含内联字面量/纯内联标注）→ **默认名**：
 *   别名形态取别名名，标注形态取 `${函数名}Ctx`——下游 extractCtxTypeInfo
 *   剥离解析（别名）或内联回退解析（标注）生成 schema，内联字段不丢
 * - `ctx: AgentToolContext` 裸标注 / 仅框架侧交叉 → `undefined`（无业务成员可校验）
 * - 关键词类型标注（`unknown`/`string` 等）→ `undefined`（无字段可校验，向后兼容）
 * - 合成名与文件内已有类型声明同名 → 抛 `SchemaExtractionError`（避免校验被同名声明劫持）
 * - 无第二参 / 无类型标注 → `undefined`
 */
function getCtxSchemaTypeName(
  fn: FunctionLike,
  sourceFile: ts.SourceFile,
  program: ts.Program,
  functionName: string,
): string | undefined {
  const secondParam = fn.parameters[1];
  if (!secondParam?.type) return undefined;
  // 提升为 const——回调内属性路径窄化丢失（defaultName 闭包需引用标注节点）
  const annotation = secondParam.type;

  if (ts.isIntersectionTypeNode(annotation)) {
    return splitCtxAnnotationName(annotation, sourceFile, () =>
      synthesizeCtxName(annotation, sourceFile, functionName),
    );
  }

  // 纯内联字面量标注：整标注解析生成 schema（默认名 = 函数名 Ctx）
  if (ts.isTypeLiteralNode(annotation)) {
    return synthesizeCtxName(annotation, sourceFile, functionName);
  }

  if (!ts.isTypeReferenceNode(annotation)) return undefined;
  const name = annotation.typeName.getText(sourceFile);
  // 裸标注框架类型：框架注入字段运行时恒有、非纯数据，不参与校验——
  // 不生成 ctx schema，运行时仅注入框架字段后直接调用 handler
  if (name === CTX_FRAMEWORK_TYPE_NAME) return undefined;

  // 命名别名解引用：别名声明指向含框架侧成员的交叉（`type Ctx = Business & AgentToolContext`）
  // 与内联交叉语义等价，不解引用则别名整体进 schema 会撞上框架字段的
  // import('...').TaskClient 类型语法构建期报错。拆分规则与标注层交叉一致
  // （splitCtxAnnotationName）。无框架侧成员的别名不解引用：整体可被
  // extractTypeInfo 解析合并，拆分反而丢成员
  const aliasDecl = findTypeAliasDeclaration(program, sourceFile, name);
  if (
    aliasDecl &&
    ts.isIntersectionTypeNode(aliasDecl.decl.type) &&
    hasFrameworkMember(aliasDecl.decl.type, aliasDecl.sourceFile)
  ) {
    return splitCtxAnnotationName(aliasDecl.decl.type, aliasDecl.sourceFile, () => name);
  }

  return name;
}

/**
 * 交叉类型按「非框架侧成员」确定 ctx 校验类型名（标注层与别名解引用共用）
 *
 * - 唯一非框架侧成员且为具名 TypeReference → 该成员名（与 extractTypeInfo 同路径）
 * - 仅框架侧（无业务成员）→ `undefined`（对齐裸标注框架类型语义）
 * - 其余（多成员/含内联字面量，无论是否含框架侧）→ `defaultName()`（默认名形态，
 *   下游 extractCtxTypeInfo 剥离解析合并全部非框架侧成员——内联字段不丢）
 */
function splitCtxAnnotationName(
  node: ts.IntersectionTypeNode,
  sourceFile: ts.SourceFile,
  defaultName: () => string,
): string | undefined {
  const members = collectNonFrameworkCtxMembers(node, sourceFile);
  if (members.length === 0) return undefined;
  const first = members[0];
  if (members.length === 1 && first && ts.isTypeReferenceNode(first)) {
    return first.typeName.getText(sourceFile);
  }
  return defaultName();
}

/**
 * 内联标注的合成 schema 名（默认名）：`${函数名}Ctx`
 *
 * 与文件内已有类型声明同名时显式抛错——合成名若被同名声明占据，解析侧
 * 「声明优先」会拿到无关类型的 schema（校验被同名声明劫持），fail-fast 要求
 * 为 ctx 校验类型命名或重命名冲突声明。
 */
function synthesizeCtxName(
  errorNode: ts.Node,
  sourceFile: ts.SourceFile,
  functionName: string,
): string {
  const synthesized = `${functionName}Ctx`;
  if (findTopLevelDecl(sourceFile, synthesized)) {
    throw SchemaExtractionError.at(
      errorNode,
      errorNode.getText(sourceFile),
      `tool ctx 内联标注的合成 schema 名 "${synthesized}" 与文件内已有类型声明同名，` +
        `校验会被同名声明劫持。请为 ctx 校验类型命名（如 interface ${synthesized}），或重命名冲突声明`,
      sourceFile,
    );
  }
  return synthesized;
}

/**
 * 收集交叉类型节点的非框架侧成员节点（按成员名跳过 `AgentToolContext`）
 *
 * 内联字面量成员保留在结果中——剥离解析合并时不可丢（`A & { b: 1 } & AgentToolContext`
 * 的 b 必须参与校验）。extractHandlerTypes 的 extractCtxTypeInfo 剥离/内联回退共用，故导出。
 */
export function collectNonFrameworkCtxMembers(
  node: ts.IntersectionTypeNode,
  sourceFile: ts.SourceFile,
): readonly ts.TypeNode[] {
  return node.types.filter(
    (member) =>
      !(
        ts.isTypeReferenceNode(member) &&
        member.typeName.getText(sourceFile) === CTX_FRAMEWORK_TYPE_NAME
      ),
  );
}

/**
 * 交叉类型是否含框架侧成员（按类型名匹配，与拆分跳过同名口径）
 *
 * 框架侧类型名与 extractToolMetadata 的标注层拆分共用——extractHandlerTypes 的
 * extractCtxTypeInfo 剥离解析依赖同一判定，故导出。
 */
export function hasFrameworkMember(
  node: ts.IntersectionTypeNode,
  sourceFile: ts.SourceFile,
): boolean {
  return node.types.some(
    (member) =>
      ts.isTypeReferenceNode(member) &&
      member.typeName.getText(sourceFile) === CTX_FRAMEWORK_TYPE_NAME,
  );
}

/**
 * 查找类型名对应的顶层 type alias 声明（命名别名解引用用）
 *
 * 本文件优先；查不到回退 program 其他源文件（跳过 node_modules / TypeScript lib，
 * 与 extractTypeInfo 的跨文件回退同构）。同名 interface / enum 不是别名，返回
 * `undefined`（维持 TypeReference 直取语义，由 extractTypeInfo 按现有规则解析）。
 * 返回声明所在 sourceFile——别名声明可能不在 handler.ts，错误定位需用其自身文件。
 */
function findTypeAliasDeclaration(
  program: ts.Program,
  sourceFile: ts.SourceFile,
  typeName: string,
): { decl: ts.TypeAliasDeclaration; sourceFile: ts.SourceFile } | undefined {
  const local = findTopLevelDecl(sourceFile, typeName);
  if (local) {
    return local.kind === 'typeAlias' ? { decl: local.node, sourceFile } : undefined;
  }
  for (const sf of program.getSourceFiles()) {
    if (sf === sourceFile) continue;
    if (sf.fileName.includes('/node_modules/') || sf.fileName.includes('typescript/lib/')) {
      continue;
    }
    const found = findTopLevelDecl(sf, typeName);
    if (found) {
      return found.kind === 'typeAlias' ? { decl: found.node, sourceFile: sf } : undefined;
    }
  }
  return undefined;
}
