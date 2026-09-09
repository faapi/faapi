import ts from 'typescript';
import {
  extractDescription,
  extractJSDocTagValue,
  getJSDocFromNode,
  hasExportModifier,
} from './jsDocMetadata';
import { SchemaExtractionError } from './resolveTypeNode';

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
  /** 系统提示词(config 块字面量提取),未声明时为 `undefined`;声明了但非字面量在构建期抛 `SchemaExtractionError` */
  systemPrompt?: string;
  /** agent 显式声明可用的 tool 引用列表(config 块字面量提取),未声明时为 `undefined`;声明了但含非字面量元素在构建期抛错 */
  tools?: string[];
  /** 可调用的其他 agent 名列表(config 块字面量提取),未声明时为 `undefined`;声明了但含非字面量元素在构建期抛错 */
  agents?: string[];
  /** LLM 模型名(config 块字面量提取),未声明时为 `undefined`;声明了但非字面量在构建期抛错 */
  model?: string;
  /** 最大对话轮数(config 块字面量提取),未声明时为 `undefined`;声明了但非数字字面量在构建期抛错 */
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
 * config 块字段提取仅接受字面量值——字符串字面量与无插值模板字符串同等提取；
 * 声明了字段但值提取失败(变量引用/含插值模板字符串/混合数组元素等)抛 `SchemaExtractionError`。
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
  const agentNameOverride = extractJSDocTagValue(jsDoc, 'agent');

  // config 块字段提取
  let systemPrompt: string | undefined;
  let tools: string[] | undefined;
  let agents: string[] | undefined;
  let model: string | undefined;
  let maxTurns: number | undefined;

  if (objectLiteral) {
    const fields = extractConfigFields(objectLiteral, sourceFile);
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
 * 从 config 对象字面量提取 config 块字段
 *
 * 遍历对象属性，按属性名匹配提取对应字段。仅接受字面量值——
 * 字符串字面量与无插值模板字符串(`NoSubstitutionTemplateLiteral`)同等提取；
 * **声明了字段但值提取失败**(变量引用/含插值模板字符串/混合数组元素等)
 * 抛 `SchemaExtractionError`——静默降级为 `undefined` 后，运行时与
 * "合法地未声明该字段"不可区分，只能在构建期拦截。
 *
 * 属性名匹配支持 Identifier 和 StringLiteral 两种形式：
 * - `{ systemPrompt: 'x' }` — Identifier 属性名
 * - `{ 'systemPrompt': 'x' }` — StringLiteral 属性名
 *
 * SpreadAssignment(`...other`)跳过——不声明任何具名字段，无法静态归属。
 *
 * @param objLit config 对象字面量
 * @param sourceFile 所在源文件(报错定位用——纯语法遍历路径无 parent 指针，
 *   `node.getSourceFile()` 不可用，需显式传入)
 */
function extractConfigFields(
  objLit: ts.ObjectLiteralExpression,
  sourceFile: ts.SourceFile,
): {
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
        result.systemPrompt = requireStringValue(prop, 'systemPrompt', sourceFile);
        break;
      case 'tools':
        result.tools = requireStringArrayValue(prop, 'tools', sourceFile);
        break;
      case 'agents':
        result.agents = requireStringArrayValue(prop, 'agents', sourceFile);
        break;
      case 'model':
        result.model = requireStringValue(prop, 'model', sourceFile);
        break;
      case 'maxTurns':
        result.maxTurns = requireNumberValue(prop, 'maxTurns', sourceFile);
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
 * 从表达式提取字符串值（StringLiteral / NoSubstitutionTemplateLiteral）
 *
 * - `'hello'` / `"hello"` → `'hello'`
 * - `` `hello` `` → `'hello'`（无插值模板字符串语义等价字符串字面量，多行人设的常见写法）
 * - 含插值模板字符串 / 变量引用 / 数字 → `undefined`
 */
function extractStringValue(expr: ts.Expression): string | undefined {
  if (isStringLikeLiteral(expr)) return expr.text;
  return undefined;
}

/**
 * 从属性赋值提取字符串字段值，声明了但提取失败抛 `SchemaExtractionError`
 *
 * 与直接用 `extractStringValue` 的区别：失败即抛错（带字段名与 file:line:column），
 * 不静默返回 `undefined`——"声明了却提取不出"是确定的构建错误。
 */
function requireStringValue(
  prop: ts.PropertyAssignment,
  fieldName: string,
  sourceFile: ts.SourceFile,
): string {
  const value = extractStringValue(prop.initializer);
  if (value === undefined) {
    throw SchemaExtractionError.at(
      prop.initializer,
      `config.${fieldName}`,
      '仅支持字符串字面量或无插值模板字符串（含插值的模板字符串/变量引用无法静态求值）',
      sourceFile,
    );
  }
  return value;
}

/**
 * 从属性赋值提取字符串数组字段值，声明了但提取失败抛 `SchemaExtractionError`
 *
 * 覆盖两种失败形态：值不是数组表达式、数组含非字符串字面量元素。
 */
function requireStringArrayValue(
  prop: ts.PropertyAssignment,
  fieldName: string,
  sourceFile: ts.SourceFile,
): string[] {
  const value = extractStringArrayValue(prop.initializer);
  if (value === undefined) {
    throw SchemaExtractionError.at(
      prop.initializer,
      `config.${fieldName}`,
      '仅支持全字符串字面量数组（元素为字符串字面量或无插值模板字符串）',
      sourceFile,
    );
  }
  return value;
}

/**
 * 从属性赋值提取数字字段值，声明了但提取失败抛 `SchemaExtractionError`
 */
function requireNumberValue(
  prop: ts.PropertyAssignment,
  fieldName: string,
  sourceFile: ts.SourceFile,
): number {
  const value = extractNumberValue(prop.initializer);
  if (value === undefined) {
    throw SchemaExtractionError.at(
      prop.initializer,
      `config.${fieldName}`,
      '仅支持数字字面量',
      sourceFile,
    );
  }
  return value;
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
 * 字符串字面量形态判断（StringLiteral 或无插值模板字符串）
 *
 * 两者 `.text` 均为去引号后的源码文本，语义等价。
 */
function isStringLikeLiteral(
  node: ts.Expression,
): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

/**
 * 从表达式提取字符串数组（ArrayLiteralExpression，全字符串字面量元素）
 *
 * - `['a', 'b']` → `['a', 'b']`
 * - `` [`a`, `b`] `` → `['a', 'b']`（无插值模板字符串元素）
 * - `['a', someVar]` → `undefined`（含非字符串字面量元素）
 * - `[]` → `[]`（空数组）
 * - 非数组 → `undefined`
 */
function extractStringArrayValue(expr: ts.Expression): string[] | undefined {
  if (!ts.isArrayLiteralExpression(expr)) return undefined;
  const values: string[] = [];
  for (const element of expr.elements) {
    if (!isStringLikeLiteral(element)) return undefined;
    values.push(element.text);
  }
  return values;
}
