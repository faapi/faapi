import ts from 'typescript';

/**
 * Agent 的 LLM 可见核心字段
 *
 * 描述"agent 是什么"——LLM 真正需要消费的字段,**不含**代码本体加载细节
 * (filePath / hasRun)。文件型 agent 与 DB-driven skill 都实现此接口。
 *
 * - 文件型 agent:由 [AgentMetadata](./extractAgentMetadata.md) 继承扩展,
 *   额外含 `filePath` / `hasRun`(代码本体加载用)
 * - DB-driven skill:业务方 plugin 从 DB 字段映射到本接口即可,无需填占位值
 *   (skill 无源文件,不走 `loadAgentModule`,自然不读 filePath / hasRun)
 *
 * `@faapi/agent` 子包的 `Agent` 类、`agentRegistry` 查询入口、`asTool` 包装
 * 都消费 `AgentCore`,实现"agent 与 skill 走同一运行时链路"。
 */
export interface AgentCore {
  /** agent 名(`@agent` JSDoc 覆盖值 或 目录推导值) */
  name: string;
  /** JSDoc 描述(agent 描述,对 LLM 可见),无 JSDoc 或 JSDoc 无自由文本时为 `undefined` */
  description?: string;
  /** 系统提示词(config 块字面量提取),无/非字面量时为 `undefined` */
  systemPrompt?: string;
  /** agent 显式声明可用的 tool 引用列表(config 块字面量提取),无/含非字面量元素时为 `undefined` */
  tools?: string[];
  /** 可调用的其他 agent 名列表(config 块字面量提取),无/含非字面量元素时为 `undefined` */
  agents?: string[];
  /** LLM 模型名(config 块字面量提取),无/非字面量时为 `undefined` */
  model?: string;
  /** 最大对话轮数(config 块字面量提取),无/非字面量时为 `undefined` */
  maxTurns?: number;
}

/**
 * Agent 完整元数据(文件型 agent)
 *
 * 继承 [AgentCore](./extractAgentMetadata.md) 的 LLM 字段,额外扩展**代码本体加载细节**:
 * - `filePath` — `loadAgentModule` 加载 `handler.js` 产物提取 `run` 函数用
 * - `hasRun` — 是否导出 `run` 函数(`Agent.executeSubAgent` 据此决定走自定义 run
 *   还是默认 reactLoop)
 *
 * DB-driven skill 不实现此接口(无源文件,无需加载),只实现 `AgentCore`。
 *
 * 由 [extractAgentMetadata](./extractAgentMetadata.md) 产出,合并路径推导字段
 * (来自 [scanAgents](../agents/scanAgents.md) 的 `AgentManifest`)与 AST 提取字段
 * (JSDoc 描述、`@agent` 覆盖名、config 块字段)。
 *
 * 字段来源：
 * - `name` — `@agent` JSDoc 覆盖值,或 `pathMeta.name`(目录推导)
 * - `filePath` / `hasRun` — 由 `pathMeta` 透传
 * - `description` — JSDoc 注释块自由文本(对 LLM 可见)
 * - `systemPrompt` / `tools` / `agents` / `model` / `maxTurns` — config 块字面量提取
 */
export interface AgentMetadata extends AgentCore {
  /** 源码相对路径(从 `pathMeta` 透传),`loadAgentModule` 据此加载 `handler.js` 提取 `run` */
  filePath: string;
  /** 是否导出 `run` 函数(从 `pathMeta` 透传),`Agent.executeSubAgent` 据此选择自定义 run / 默认 reactLoop */
  hasRun: boolean;
}

/**
 * 路径推导的 agent 元数据(由 [scanAgents](../agents/scanAgents.ts) 计算)
 *
 * 透传到 [AgentMetadata](./extractAgentMetadata.ts) 输出,与 AST 提取字段合并。
 * 与 [ToolPathMeta](./extractToolMetadata.md) 对称。
 */
export interface AgentPathMeta {
  /** 目录推导的 agent 名(如 `researcher`) */
  name: string;
  /** 源码相对路径(如 `src/agents/researcher/handler.ts`) */
  filePath: string;
  /** 是否导出 `run` 函数(scanAgents 正则检测) */
  hasRun: boolean;
}

/** config 导出查找结果：JSDoc 持有节点 + 对象字面量(可能为 null) */
interface FoundConfig {
  /** JSDoc 持有节点(VariableStatement 或 FunctionDeclaration) */
  jsDocOwner: ts.Node;
  /** config 对象字面量(export const config = {...} 的 initializer 或 export function config() 的 return 值) */
  objectLiteral: ts.ObjectLiteralExpression | null;
}

/**
 * 从 agent handler.ts 提取 agent 的完整元数据
 *
 * 提取内容：
 * 1. **JSDoc 描述** — config 导出的 JSDoc 自由文本(无 config 时从 run 导出提取)
 * 2. **`@agent` 覆盖名** — JSDoc 中 `@agent` 标签后的文本，覆盖目录推导的 `name`
 * 3. **config 块字段** — systemPrompt / tools / agents / model / maxTurns
 *
 * 不提取(由 `pathMeta` 透传)：`filePath` / `hasRun`
 *
 * config 查找支持两种导出形式，与 [scanAgents](../agents/scanAgents.md) 的 `CONFIG_EXPORT_RE` 正则同构：
 * - `export const config = { ... }` — 对象字面量(最常见)
 * - `export function config() { return { ... } }` — 函数返回对象
 *
 * JSDoc 查找对箭头函数/函数表达式自动回溯到外层 `VariableStatement`
 * (JSDoc 通常写在 `export const` 上方，而非箭头函数本身)。
 * 与 [extractToolMetadata](./extractToolMetadata.md) 的 JSDoc 查找同构。
 *
 * config 块字段提取仅处理字面量值——变量引用/Spread/模板字符串等非静态值返回 `undefined`。
 *
 * @param program TypeScript Program
 * @param filePath 源文件**绝对路径**(AST 用，需与 `program.getSourceFile` 一致)
 * @param pathMeta 路径推导的元数据(scanAgents 已计算)
 * @returns `AgentMetadata` 或 `null`(源文件不在 Program 中)
 */
export function extractAgentMetadata(
  program: ts.Program,
  filePath: string,
  pathMeta: AgentPathMeta,
): AgentMetadata | null {
  const sourceFile = program.getSourceFile(filePath);
  if (!sourceFile) return null;

  // 查找 config 导出(优先提取 JSDoc + config 块字段)
  const configFound = findConfigExport(sourceFile);
  let jsDocOwner: ts.Node | null = null;
  let objectLiteral: ts.ObjectLiteralExpression | null = null;

  if (configFound) {
    jsDocOwner = configFound.jsDocOwner;
    objectLiteral = configFound.objectLiteral;
  } else if (pathMeta.hasRun) {
    // 无 config 时从 run 导出提取 JSDoc
    const runNode = findRunExport(sourceFile);
    if (runNode) {
      jsDocOwner = runNode;
    }
  }

  const jsDoc = jsDocOwner ? getJSDocFromNode(jsDocOwner) : undefined;
  const description = extractDescription(jsDoc);
  const agentNameOverride = extractAgentTagValue(jsDoc);

  // config 块字段提取
  let systemPrompt: string | undefined;
  let tools: string[] | undefined;
  let agents: string[] | undefined;
  let model: string | undefined;
  let maxTurns: number | undefined;

  if (objectLiteral) {
    const fields = extractConfigFields(objectLiteral);
    systemPrompt = fields.systemPrompt;
    tools = fields.tools;
    agents = fields.agents;
    model = fields.model;
    maxTurns = fields.maxTurns;
  }

  return {
    name: agentNameOverride ?? pathMeta.name,
    description,
    filePath: pathMeta.filePath,
    hasRun: pathMeta.hasRun,
    systemPrompt,
    tools,
    agents,
    model,
    maxTurns,
  };
}

/**
 * 在源文件中查找 `config` 导出
 *
 * 支持两种形式：
 * - `export const config = { ... }` → VariableStatement，对象字面量是 initializer
 * - `export function config() { return { ... } }` → FunctionDeclaration，对象字面量是 return 表达式
 *
 * 返回 JSDoc 持有节点和对象字面量(可能为 null——函数无 return / return 非对象字面量)。
 *
 * 不依赖 `node.parent` 链——`ts.createProgram` 配置 `noEmit: true` 时不会设置父指针。
 */
function findConfigExport(sourceFile: ts.SourceFile): FoundConfig | null {
  let result: FoundConfig | null = null;

  ts.forEachChild(sourceFile, (node) => {
    if (result) return;

    // export const config = { ... }
    if (ts.isVariableStatement(node) && hasExportModifier(node)) {
      for (const decl of node.declarationList.declarations) {
        if (result) break;
        const nameText = ts.isIdentifier(decl.name) ? decl.name.text : '';
        if (nameText !== 'config' || !decl.initializer) continue;

        // 对象字面量：export const config = { ... }
        if (ts.isObjectLiteralExpression(decl.initializer)) {
          result = { jsDocOwner: node, objectLiteral: decl.initializer };
        }
        // 箭头函数返回对象：export const config = () => ({ ... })
        else if (ts.isArrowFunction(decl.initializer)) {
          const returnObj = getReturnObjectLiteral(decl.initializer);
          result = { jsDocOwner: node, objectLiteral: returnObj };
        }
      }
    }

    // export function config() { return { ... } }
    if (ts.isFunctionDeclaration(node) && hasExportModifier(node) && node.name?.text === 'config') {
      const returnObj = getReturnObjectLiteral(node);
      result = { jsDocOwner: node, objectLiteral: returnObj };
    }
  });

  return result;
}

/**
 * 在源文件中查找 `run` 导出(用于 JSDoc 回退)
 *
 * 支持：`export function run` / `export async function run` / `export const run = () =>`
 * 返回 JSDoc 持有节点(FunctionDeclaration 本身 或 VariableStatement)。
 */
function findRunExport(sourceFile: ts.SourceFile): ts.Node | null {
  let result: ts.Node | null = null;

  ts.forEachChild(sourceFile, (node) => {
    if (result) return;

    // export function run() / export async function run()
    if (ts.isFunctionDeclaration(node) && hasExportModifier(node) && node.name?.text === 'run') {
      result = node;
      return;
    }

    // export const run = () => {}
    if (ts.isVariableStatement(node) && hasExportModifier(node)) {
      for (const decl of node.declarationList.declarations) {
        if (result) break;
        const nameText = ts.isIdentifier(decl.name) ? decl.name.text : '';
        if (nameText !== 'run' || !decl.initializer) continue;
        if (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)) {
          result = node; // JSDoc 持有者是 VariableStatement
        }
      }
    }
  });

  return result;
}

/**
 * 从函数体中提取 return 的对象字面量
 *
 * - `() => ({ ... })` — 箭头函数直接返回对象字面量(body 是 ObjectLiteralExpression)
 * - `() => { return { ... }; }` — block body 中的 return 语句
 * - `function f() { return { ... }; }` — block body 中的 return 语句
 *
 * 无 return / return 非对象字面量 → null
 */
function getReturnObjectLiteral(
  fn: ts.FunctionDeclaration | ts.ArrowFunction,
): ts.ObjectLiteralExpression | null {
  const body = fn.body;
  if (!body) return null;

  // 箭头函数直接返回对象字面量：() => ({ ... })
  if (ts.isObjectLiteralExpression(body)) {
    return body;
  }

  // block body：查找 return 语句
  if (ts.isBlock(body)) {
    for (const stmt of body.statements) {
      if (
        ts.isReturnStatement(stmt) &&
        stmt.expression &&
        ts.isObjectLiteralExpression(stmt.expression)
      ) {
        return stmt.expression;
      }
    }
  }

  return null;
}

/**
 * 判断节点是否有 `export` 修饰符
 */
function hasExportModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const modifiers = ts.getModifiers(node);
  return !!modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

/**
 * 从节点提取第一个 JSDoc 注释块
 *
 * 1. 标准 API(`ts.getJSDocCommentsAndTags`)
 * 2. 回退：直接访问 `node.jsDoc` 数组(解析器存入，jsDocCache 未同步的情况)
 *
 * 与 [extractToolMetadata](./extractToolMetadata.md) 的 `getJSDocFromNode` 同构。
 */
function getJSDocFromNode(node: ts.Node): ts.JSDoc | undefined {
  const apiDocs = ts
    .getJSDocCommentsAndTags(node)
    .filter((entry): entry is ts.JSDoc => ts.isJSDoc(entry));
  if (apiDocs.length > 0) return apiDocs[0];

  const directDocs = (node as unknown as { jsDoc?: ts.JSDoc[] }).jsDoc;
  if (directDocs && directDocs.length > 0) return directDocs[0];

  return undefined;
}

/**
 * 提取 JSDoc 描述(注释块自由文本，`@tag` 之前的首段)
 *
 * 多行描述保留换行(TypeScript 已自动剥离每行前缀 ` * `)。
 * 无 JSDoc / JSDoc 无自由文本 / 描述仅空白 → `undefined`。
 *
 * 与 [extractToolMetadata](./extractToolMetadata.md) 的 `extractDescription` 同构。
 */
function extractDescription(jsDoc: ts.JSDoc | undefined): string | undefined {
  if (!jsDoc) return undefined;
  if (typeof jsDoc.comment !== 'string') return undefined;
  const trimmed = jsDoc.comment.trim();
  return trimmed || undefined;
}

/**
 * 提取 `@agent` 标签的覆盖名
 *
 * - `@agent researcher` → `'researcher'`
 * - `@agent {researcher}` → `'researcher'`(去花括号)
 * - 描述 + `@agent researcher`(同一 JSDoc 块内)→ `'researcher'`
 * - 无 `@agent` 标签 / 标签无值 → `undefined`(调用方回退到 `pathMeta.name`)
 *
 * 与 [extractToolMetadata](./extractToolMetadata.md) 的 `extractToolTagValue` 同构。
 */
function extractAgentTagValue(jsDoc: ts.JSDoc | undefined): string | undefined {
  if (!jsDoc || !jsDoc.tags) return undefined;
  for (const tag of jsDoc.tags) {
    if (tag.tagName.text !== 'agent') continue;
    if (typeof tag.comment !== 'string') return undefined;
    const text = tag.comment.trim();
    if (!text) return undefined;
    // 去掉花括号包裹(如 {customName} → customName)
    const cleaned = text.replace(/^\{|\}$/g, '').trim();
    return cleaned || undefined;
  }
  return undefined;
}

/**
 * 从 config 对象字面量提取 config 块字段
 *
 * 遍历对象属性，按属性名匹配提取对应字段。仅处理字面量值——
 * 变量引用/Spread/模板字符串等非静态值返回 `undefined`。
 *
 * 属性名匹配支持 Identifier 和 StringLiteral 两种形式：
 * - `{ systemPrompt: 'x' }` — Identifier 属性名
 * - `{ 'systemPrompt': 'x' }` — StringLiteral 属性名
 *
 * SpreadAssignment(`...other`)跳过——无法静态求值。
 */
function extractConfigFields(objLit: ts.ObjectLiteralExpression): {
  systemPrompt?: string;
  tools?: string[];
  agents?: string[];
  model?: string;
  maxTurns?: number;
} {
  const result: {
    systemPrompt?: string;
    tools?: string[];
    agents?: string[];
    model?: string;
    maxTurns?: number;
  } = {};

  for (const prop of objLit.properties) {
    // 跳过 SpreadAssignment（...other）
    if (!ts.isPropertyAssignment(prop)) continue;

    const propName = getPropertyName(prop.name);
    if (!propName) continue;

    switch (propName) {
      case 'systemPrompt':
        result.systemPrompt = extractStringValue(prop.initializer);
        break;
      case 'tools':
        result.tools = extractStringArrayValue(prop.initializer);
        break;
      case 'agents':
        result.agents = extractStringArrayValue(prop.initializer);
        break;
      case 'model':
        result.model = extractStringValue(prop.initializer);
        break;
      case 'maxTurns':
        result.maxTurns = extractNumberValue(prop.initializer);
        break;
    }
  }

  return result;
}

/**
 * 从属性名节点提取字符串名
 *
 * 支持：
 * - Identifier（`systemPrompt` → `'systemPrompt'`）
 * - StringLiteral（`'systemPrompt'` → `'systemPrompt'`）
 *
 * ComputedPropertyName / NumericLiteral / PrivateIdentifier → null
 */
function getPropertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name)) return name.text;
  return null;
}

/**
 * 从表达式提取字符串值（仅 StringLiteral）
 *
 * - `'hello'` → `'hello'`
 * - `"hello"` → `'hello'`
 * - 模板字符串 / 变量引用 / 数字 → `undefined`
 */
function extractStringValue(expr: ts.Expression): string | undefined {
  if (ts.isStringLiteral(expr)) return expr.text;
  return undefined;
}

/**
 * 从表达式提取数字值（仅 NumericLiteral）
 *
 * - `10` → `10`
 * - `'10'` / 变量引用 → `undefined`
 */
function extractNumberValue(expr: ts.Expression): number | undefined {
  if (ts.isNumericLiteral(expr)) {
    const num = Number(expr.text);
    return Number.isNaN(num) ? undefined : num;
  }
  return undefined;
}

/**
 * 从表达式提取字符串数组（ArrayLiteralExpression，全 StringLiteral 元素）
 *
 * - `['a', 'b']` → `['a', 'b']`
 * - `['a', someVar]` → `undefined`（含非 StringLiteral 元素）
 * - `[]` → `[]`（空数组）
 * - 非数组 → `undefined`
 */
function extractStringArrayValue(expr: ts.Expression): string[] | undefined {
  if (!ts.isArrayLiteralExpression(expr)) return undefined;
  const values: string[] = [];
  for (const element of expr.elements) {
    if (!ts.isStringLiteral(element)) return undefined;
    values.push(element.text);
  }
  return values;
}
