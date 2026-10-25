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
 * 描述"agent 是什么"——LLM 真正需要消费的字段,**不含**声明文件定位信息
 * (filePath)。文件型 agent 与 DB-driven skill 都实现此接口。
 *
 * - 文件型 agent:由 [AgentMetadata](./extractAgentMetadata.md) 继承扩展,
 *   额外含 `filePath`(声明文件定位用)
 * - DB-driven skill:业务方 plugin 从 DB 字段映射到本接口即可,无需填占位值
 *   (skill 无源文件,自然不读 filePath)
 *
 * `@faapi/agent` 子包的 `Agent` 类、`agentRegistry` 查询入口、`asTool` 包装
 * 都消费 `AgentCore`,实现"agent 与 skill 走同一运行时链路"。
 */
export interface AgentCore {
  /** agent 名(目录路径推导值,嵌套段用 `_` 连接) */
  name: string;
  /** JSDoc 描述(agent 描述,对 LLM 可见),无 JSDoc 或 JSDoc 无自由文本时为 `undefined` */
  description?: string;
  /** 系统提示词(config 块字面量提取);文件型 agent 必填(构建期校验),DB skill 由业务方自治 */
  systemPrompt?: string;
  /**
   * 系统提示词文件路径(config 块字面量提取),相对产物 resources 目录
   * (`<dist>/resources/`,运行时经免传参 `readResource` 读取),与 `systemPrompt` 互斥
   * (都声明构建期抛错,二选一必填)
   *
   * 运行时每次 run 读文件内容作为 systemPrompt——dev 改 prompt 文件经 watcher
   * 增量复制后立即生效,无需 reload;`deps.resourcesDir` 未注入或文件读取失败
   * 时抛 `AgentError`(不静默降级)
   */
  systemPromptFile?: string;
  /** agent 显式声明可用的 tool 引用列表(config 块字面量提取),未声明时为 `undefined`;声明了但含无法静态求值的元素在构建期抛错 */
  tools?: string[];
  /** 可调用的其他 agent 名列表(config 块字面量提取),未声明时为 `undefined`;声明了但含无法静态求值的元素在构建期抛错 */
  agents?: string[];
  /** 最大对话轮数(config 块字面量提取),未声明时为 `undefined`;声明了但非数字字面量在构建期抛错 */
  maxTurns?: number;
  /**
   * agent-as-tool 派发交接单说明(config 块字面量提取),未声明时为 `undefined`;
   * 声明了但非字面量在构建期抛错
   *
   * 该 agent 被其他 agent 当 tool 派发时(`agents` 列表引用),工具 `input` 字段的
   * schema description——告诉主控 LLM 该传什么样的交接单;未声明时 `@faapi/agent`
   * 的 `buildToolDefinitions` 用框架默认文案
   */
  inputDescription?: string;
  /**
   * 提示词模板变量(config 块字面量提取,静态值),未声明时为 `undefined`;
   * 声明了但含非字面量叶子(嵌套对象/数组/标识符引用/含插值模板字符串等)在构建期抛错
   *
   * 声明后 agent 的 systemPrompt / systemPromptFile 内容中的 `{{key}}` 占位符在
   * 每次 run / sub-agent 派发时按 vars 渲染(同一 agent 每次运行渲染相同内容——
   * 用于「同一提示词模板复用 + agent 间静态特化」);未声明时提示词原样使用
   * (占位符不渲染)。运行时渲染见 `@faapi/agent` 的 promptTemplate.md
   */
  vars?: Record<string, string | number | boolean>;
  /**
   * 提醒注入（config 块字面量提取,静态字符串数组),未声明时为 `undefined`;
   * 声明了但含无法静态求值的元素在构建期抛错
   *
   * 单 agent 固定提醒——每条在该 agent 的对话首轮 user 消息上持久注入
   * `<system-reminder>` 包裹块（once 通道,见 `@faapi/agent` 的 reminders.md）。
   * 与全局声明面（faapi.config `agent.reminders`,支持动态函数）合并时排在其后
   * （更靠近上下文末端）。声明是 string[]（全 once）——AST 字面量提取只能给
   * 静态文本,动态提醒走全局声明面的函数 spec 按 agentName 分支
   */
  reminders?: string[];
}

/**
 * Agent 完整元数据(文件型 agent)
 *
 * 继承 [AgentCore](./extractAgentMetadata.md) 的 LLM 字段,额外扩展声明文件定位:
 * - `filePath` — 声明文件源码相对路径(启动日志 / 清单可观测性用)
 *
 * agent 统一为声明式执行(config + 默认 reactLoop)——自定义 `run` 导出已移除,
 * 检测到 run 导出在提取阶段抛迁移错误(编排场景注册 tool)。
 *
 * DB-driven skill 不实现此接口(无源文件),只实现 `AgentCore`。
 *
 * 由 [extractAgentMetadata](./extractAgentMetadata.md) 产出,合并路径推导字段
 * (来自 [scanAgents](../agents/scanAgents.md) 的 `AgentManifest`)与 AST 提取字段
 * (JSDoc 描述、config 块字段)。
 *
 * 字段来源：
 * - `name` — `pathMeta.name`(目录路径推导,嵌套段用 `_` 连接)
 * - `filePath` — 由 `pathMeta` 透传
 * - `description` — JSDoc 注释块自由文本(对 LLM 可见)
 * - `systemPrompt` / `systemPromptFile` / `tools` / `agents` / `maxTurns` / `inputDescription` — config 块字面量提取
 */
export interface AgentMetadata extends AgentCore {
  /** 源码相对路径(从 `pathMeta` 透传)——声明文件定位与清单可观测性用 */
  filePath: string;
  /**
   * 派发入参 schema 声明(handler.ts 顶层 `interface Input` / `type Input` 检测)
   *
   * 声明时为 `'Input'`——[generateAgentArtifacts](../cli/generateAgentArtifacts.md)
   * 据此生成 agent 的 zod.js,`@faapi/agent` 派发该 agent 时用富 JSON Schema 替代
   * 默认单字段 `input` 交接单并在执行前校验;未声明为 `undefined`,派发行为不变
   * (完全向后兼容)。DB-driven skill 无源文件,恒为 `undefined`。
   */
  inputTypeName?: string;
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
 * 1. **JSDoc 描述** — config 导出的 JSDoc 自由文本
 * 2. **config 块字段** — systemPrompt / systemPromptFile / tools / agents / maxTurns / inputDescription / vars / reminders
 * 3. **派发入参 schema 声明** — 顶层 `interface Input` / `type Input` 名字检测（记 `inputTypeName`，
 *    类型提取由 generateAgentArtifacts 阶段完成）
 *
 * 不提取(由 `pathMeta` 透传)：`filePath`
 *
 * config 查找支持两种导出形式，与 [scanAgents](../agents/scanAgents.md) 的 `CONFIG_EXPORT_RE` 正则同构：
 * - `export const config = { ... }` — 对象字面量(最常见)
 * - `export function config() { return { ... } }` — 函数返回对象
 *
 * JSDoc 查找对箭头函数/函数表达式自动回溯到外层 `VariableStatement`
 * (JSDoc 通常写在 `export const` 上方，而非箭头函数本身)。
 * 与 [extractToolMetadata](./extractToolMetadata.md) 的 JSDoc 查找同构。
 *
 * config 块字段提取仅接受静态可求值的字符串值——字符串字面量、无插值模板字符串及
 * 其 `+` 拼接同等提取；声明了字段但值提取失败(变量引用/含插值模板字符串/拼接混入
 * 数字/混合数组元素等)抛 `SchemaExtractionError`。
 * `systemPrompt` / `systemPromptFile` 二选一必填——无 config 导出、config 无 return
 * 对象、两者皆缺均抛错，提示词是 agent 的必要组成；两者同时声明抛互斥错。
 *
 * **自定义 `run` 导出已移除**——agent 统一为声明式执行（config + 默认 reactLoop），
 * 检测到 run 导出抛迁移错误（编排场景注册 tool / 多 agent 协作用 config.agents）。
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

  // 自定义 run 已移除——检测到 run 导出显式报迁移错误（不静默忽略：静默后 run
  // 变成无人消费的死代码，与声明意图不符）
  const runOwner = findRunExportOwner(sourceFile);
  if (runOwner) {
    throw SchemaExtractionError.at(
      runOwner,
      'run',
      'agent 自定义 run 已移除——agent 统一为声明式执行（config + 默认 reactLoop）。' +
        '编排场景请注册 tool（src/tools/ 下导出函数，有 schema/trace/鉴权钩子），' +
        '多 agent 协作用 config.agents 声明 sub-agent',
      sourceFile,
    );
  }

  // systemPrompt / systemPromptFile 二选一必填——config 是提示词的唯一载体，无 config
  // 导出时直接抛错。不存在合法的无提示词文件型 agent（JSDoc description 只是用途
  // 说明，不构成提示词）。
  const configFound = findConfigExport(sourceFile);
  if (!configFound) {
    throw SchemaExtractionError.at(
      sourceFile,
      'config.systemPrompt',
      'agent 必填——请在 config 块声明 systemPrompt（字符串字面量、无插值模板字符串或其 + 拼接）或 systemPromptFile（相对 resources 目录的路径字面量）二选一',
      sourceFile,
    );
  }
  // 声明了 config 但提取不出对象字面量——形式不支持，与"未声明"分开提示，
  // 避免"请在 config 块声明"误导已声明 config 的用户
  if (!configFound.objectLiteral) {
    throw SchemaExtractionError.at(
      configFound.jsDocOwner,
      'config',
      '仅支持对象字面量、箭头函数返回对象字面量或函数返回对象字面量',
      sourceFile,
    );
  }
  const objectLiteral = configFound.objectLiteral;

  const jsDoc = getJSDocFromNode(configFound.jsDocOwner);
  const description = extractDescription(jsDoc);
  // @agent 覆盖名已移除——检测到残留标签抛迁移错误（不静默忽略：覆盖语义已不存在，
  // 标签变成无人消费的死注解，与声明意图不符）。无值的裸标签（tag.comment 为 false）
  // extractJSDocTagValue 返回 undefined，不构成残留，维持回退语义不报错
  const agentNameOverride = extractJSDocTagValue(jsDoc, 'agent');
  if (agentNameOverride !== undefined) {
    throw SchemaExtractionError.at(
      configFound.jsDocOwner,
      '@agent',
      '@agent 覆盖名功能已移除——agent 名由目录路径推导（嵌套段用 _ 连接）。' +
        '删除 @agent JSDoc 标签；需要不同名字时改名目录',
      sourceFile,
    );
  }

  // config 块字段提取（extractConfigFields 保证 systemPrompt/systemPromptFile 二选一非空）
  const {
    systemPrompt,
    systemPromptFile,
    tools,
    agents,
    maxTurns,
    inputDescription,
    vars,
    reminders,
  } = extractConfigFields(objectLiteral, sourceFile);

  return {
    name: pathMeta.name,
    description,
    filePath: pathMeta.filePath,
    systemPrompt,
    systemPromptFile,
    tools,
    agents,
    maxTurns,
    inputDescription,
    vars,
    reminders,
    inputTypeName: findInputDeclaration(sourceFile) ? 'Input' : undefined,
  };
}

/**
 * 检测派发入参 schema 声明：源文件顶层是否存在名为 `Input` 的 interface / type alias
 *
 * 固定约定名——tool 的入参类型名由「函数第一参数的类型标注」定位，agent 无函数入参
 * （声明式执行），固定名是唯一可预测的约定；`Input` 之外的类型导出（如 `Payload`）
 * 不构成声明。
 *
 * - 导出与否不限——AST 按名字在顶层 statements 定位声明，与 tool 的参数类型未导出
 *   也能提取一致（zod.js 自包含，不依赖运行时导出）
 * - 同名非类型导出（`const Input` / class）与 import 进来的同名类型（无本地声明）
 *   均不构成声明
 * - 只做名字检测，不做类型解析——AST → RuntimeType 提取由 generateAgentArtifacts
 *   阶段经 extractTypeInfo 完成（复用其已创建的 Program）
 */
function findInputDeclaration(sourceFile: ts.SourceFile): boolean {
  let found = false;
  ts.forEachChild(sourceFile, (node) => {
    if (found) return;
    if (
      (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) &&
      node.name.text === 'Input'
    ) {
      found = true;
    }
  });
  return found;
}

/**
 * 查找 `run` 导出节点（自定义 run 已移除——检测到即抛迁移错误）
 *
 * 支持 `export function run(...)` / `export async function run(...)` /
 * `export const run = ...`（VariableStatement）。
 * 未找到返回 null（声明式 agent，正常路径）。
 */
function findRunExportOwner(sourceFile: ts.SourceFile): ts.Node | null {
  let result: ts.Node | null = null;
  ts.forEachChild(sourceFile, (node) => {
    if (result) return;
    if (ts.isFunctionDeclaration(node) && hasExportModifier(node) && node.name?.text === 'run') {
      result = node;
      return;
    }
    if (ts.isVariableStatement(node) && hasExportModifier(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === 'run') {
          result = node;
          return;
        }
      }
    }
  });
  return result;
}

/**
 * 在源文件中查找 `config` 导出
 *
 * 支持两种形式：
 * - `export const config = { ... }` → VariableStatement，对象字面量是 initializer
 * - `export function config() { return { ... } }` → FunctionDeclaration，对象字面量是 return 表达式
 *
 * 返回 JSDoc 持有节点和对象字面量(可能为 null——函数无 return / return 非对象字面量 /
 * const initializer 非对象字面量与箭头函数)。`objectLiteral` 为 null 而 `jsDocOwner`
 * 已定位时，表达"声明了 config 但形式不支持"，与"未声明 config"(返回 null)区分。
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

        // 记录 config 导出——形式是否支持由 objectLiteral 是否为 null 表达，
        // 调用方据此区分"未声明 config"与"声明了但形式不支持"
        if (ts.isObjectLiteralExpression(decl.initializer)) {
          result = { jsDocOwner: node, objectLiteral: decl.initializer };
        } else if (ts.isArrowFunction(decl.initializer)) {
          result = { jsDocOwner: node, objectLiteral: getReturnObjectLiteral(decl.initializer) };
        } else {
          result = { jsDocOwner: node, objectLiteral: null };
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
 * 在源文件中查找 `config` 导出
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
 * 遍历对象属性，按属性名匹配提取对应字段。仅接受静态可求值的字符串值——
 * 字符串字面量、无插值模板字符串(`NoSubstitutionTemplateLiteral`)及其 `+` 拼接
 * 同等提取；**声明了字段但值提取失败**(变量引用/含插值模板字符串/拼接混入数字/
 * 混合数组元素等)抛 `SchemaExtractionError`——静默降级为 `undefined` 后，运行时与
 * "合法地未声明该字段"不可区分，只能在构建期拦截。
 *
 * 属性名匹配支持 Identifier 和 StringLiteral 两种形式：
 * - `{ systemPrompt: 'x' }` — Identifier 属性名
 * - `{ 'systemPrompt': 'x' }` — StringLiteral 属性名
 *
 * SpreadAssignment(`...other`)跳过——不声明任何具名字段，无法静态归属。
 * 未知字段（拼写错误/框架不读的 key）与不支持的属性形式（shorthand/方法/
 * getter/computed 名）抛 `SchemaExtractionError`，不静默忽略。
 *
 * 返回类型的 `systemPrompt` 必填——属性存在但提取失败由 `requireStringValue`
 * 抛错，属性未声明(空对象/缺 key/仅 spread)由返回前校验抛错，正常返回时必有值。
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
  systemPromptFile?: string;
  tools?: string[];
  agents?: string[];
  maxTurns?: number;
  inputDescription?: string;
  vars?: Record<string, string | number | boolean>;
  reminders?: string[];
} {
  let systemPrompt: string | undefined;
  let systemPromptFile: string | undefined;
  let tools: string[] | undefined;
  let agents: string[] | undefined;
  let maxTurns: number | undefined;
  let inputDescription: string | undefined;
  let vars: Record<string, string | number | boolean> | undefined;
  let reminders: string[] | undefined;

  for (const prop of objLit.properties) {
    // 跳过 SpreadAssignment（...other）
    if (ts.isSpreadAssignment(prop)) continue;

    // shorthand / 方法 / getter 等形式——config 只支持 key: value 字面量属性
    if (!ts.isPropertyAssignment(prop)) {
      throw SchemaExtractionError.at(
        prop,
        'config',
        '仅支持 key: value 属性形式（不支持 shorthand/方法/getter）',
        sourceFile,
      );
    }

    const propName = getPropertyName(prop.name);
    if (!propName) {
      throw SchemaExtractionError.at(prop.name, 'config', '不支持 computed 属性名', sourceFile);
    }

    switch (propName) {
      case 'systemPrompt':
        systemPrompt = requireStringValue(prop, 'systemPrompt', sourceFile);
        break;
      case 'systemPromptFile':
        systemPromptFile = requireStringValue(prop, 'systemPromptFile', sourceFile);
        break;
      case 'tools':
        tools = requireStringArrayValue(prop, 'tools', sourceFile);
        break;
      case 'agents':
        agents = requireStringArrayValue(prop, 'agents', sourceFile);
        break;
      case 'model':
        // config.model 已移除——模型档位是调用侧决策（agent.run/stream options.model
        // 显式传），不是 agent 的静态属性。声明了就报迁移错误（任意值任意形式，含
        // 字符串属性名 'model'），不静默忽略：静默后声明变无人消费的死配置，与
        // 声明意图不符
        throw SchemaExtractionError.at(
          prop,
          'config.model',
          'config.model 已移除——模型档位是调用侧决策：agent.run/stream 显式传 options.model（或 options.provider 外部 provider 自决），sub-agent 派发未声明 model 时沿用父调用模型。请删除 handler 里的 model 声明',
          sourceFile,
        );
      case 'maxTurns':
        maxTurns = requireNumberValue(prop, 'maxTurns', sourceFile);
        break;
      case 'inputDescription':
        inputDescription = requireStringValue(prop, 'inputDescription', sourceFile);
        break;
      case 'vars':
        vars = requireVarsValue(prop, sourceFile);
        break;
      case 'reminders':
        reminders = requireStringArrayValue(prop, 'reminders', sourceFile);
        break;
      default:
        // 框架不读的字段几乎必然是拼写错误或误解——静默忽略后运行时按默认值
        // 跑，与声明意图不符（如 maxTurn 拼错后轮数走默认值）
        throw SchemaExtractionError.at(
          prop,
          `config.${propName}`,
          '未知 config 字段——仅支持 systemPrompt / systemPromptFile / tools / agents / maxTurns / inputDescription / vars / reminders',
          sourceFile,
        );
    }
  }

  // systemPrompt 与 systemPromptFile 互斥：两个来源语义冲突,构建期显式报错
  // (而非运行时静默取其一,与声明意图不符)
  if (systemPrompt !== undefined && systemPromptFile !== undefined) {
    throw SchemaExtractionError.at(
      objLit,
      'config.systemPrompt',
      'systemPrompt 与 systemPromptFile 互斥——内联系统提示词与 resources 文件二选一',
      sourceFile,
    );
  }

  // 皆缺报错：提示词是 agent 的必要组成（systemPrompt 与 systemPromptFile 二选一）
  if (systemPrompt === undefined && systemPromptFile === undefined) {
    throw SchemaExtractionError.at(
      objLit,
      'config.systemPrompt',
      'agent 必填——请在 config 块声明 systemPrompt（字符串字面量、无插值模板字符串或其 + 拼接）或 systemPromptFile（相对 resources 目录的路径字面量）二选一',
      sourceFile,
    );
  }

  return {
    systemPrompt,
    systemPromptFile,
    tools,
    agents,
    maxTurns,
    inputDescription,
    vars,
    reminders,
  };
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
 * 从表达式提取字符串值（StringLiteral / NoSubstitutionTemplateLiteral / 其 + 拼接）
 *
 * - `'hello'` / `"hello"` → `'hello'`
 * - `` `hello` `` → `'hello'`（无插值模板字符串语义等价字符串字面量，多行人设的常见写法）
 * - `'a' + 'b'`（含链式 `'a' + 'b' + 'c'`，左结合递归展开）→ `'abc'`——纯字面量拼接
 *   静态可求值，多行提示词的常见写法
 * - 含插值模板字符串 / 变量引用 / 数字（`'a' + 1`）/ 非 `+` 运算符 → `undefined`
 */
function extractStringValue(expr: ts.Expression): string | undefined {
  if (isStringLikeLiteral(expr)) return expr.text;
  // 字符串字面量的 + 拼接：两侧递归求值，任一侧不可求值即整体失败
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = extractStringValue(expr.left);
    if (left === undefined) return undefined;
    const right = extractStringValue(expr.right);
    if (right === undefined) return undefined;
    return left + right;
  }
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
      '仅支持字符串字面量、无插值模板字符串或其 + 拼接（含插值的模板字符串/变量引用/数字无法静态求值为字符串）',
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
      '仅支持全字符串字面量数组（元素为字符串字面量、无插值模板字符串或其 + 拼接）',
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
 * 从属性赋值提取提示词模板变量（config.vars），声明了但提取失败抛 `SchemaExtractionError`
 *
 * 仅接受平面对象字面量，叶子为静态字面量：
 * - string：字符串字面量 / 无插值模板字符串 / 其 `+` 拼接（与 systemPrompt 同规则）
 * - number：数字字面量
 * - boolean：`true` / `false`
 *
 * 嵌套对象 / 数组 / null·undefined / 标识符引用 / 含插值模板字符串 / spread 等
 * 静态不可求值的叶子抛 `SchemaExtractionError`——vars 随 faapi-agents.js 清单
 * JSON 序列化，声明了却提取不出与「合法地未声明」在运行时不可区分，只能在构建期拦截。
 */
function requireVarsValue(
  prop: ts.PropertyAssignment,
  sourceFile: ts.SourceFile,
): Record<string, string | number | boolean> {
  const initializer = prop.initializer;
  if (!ts.isObjectLiteralExpression(initializer)) {
    throw SchemaExtractionError.at(
      initializer,
      'config.vars',
      '仅支持平面对象字面量（叶子为字符串/数字/布尔字面量）',
      sourceFile,
    );
  }

  const vars: Record<string, string | number | boolean> = {};
  for (const leaf of initializer.properties) {
    if (ts.isSpreadAssignment(leaf)) {
      throw SchemaExtractionError.at(
        leaf,
        'config.vars',
        '不支持 spread——vars 叶子必须是静态字面量（spread 无法静态求值）',
        sourceFile,
      );
    }
    if (!ts.isPropertyAssignment(leaf)) {
      throw SchemaExtractionError.at(
        leaf,
        'config.vars',
        '仅支持 key: value 属性形式（不支持 shorthand/方法/getter）',
        sourceFile,
      );
    }
    const key = getPropertyName(leaf.name);
    if (!key) {
      throw SchemaExtractionError.at(
        leaf.name,
        'config.vars',
        '不支持 computed 属性名',
        sourceFile,
      );
    }

    const valueExpr = leaf.initializer;
    const str = extractStringValue(valueExpr);
    if (str !== undefined) {
      vars[key] = str;
      continue;
    }
    const num = extractNumberValue(valueExpr);
    if (num !== undefined) {
      vars[key] = num;
      continue;
    }
    if (
      valueExpr.kind === ts.SyntaxKind.TrueKeyword ||
      valueExpr.kind === ts.SyntaxKind.FalseKeyword
    ) {
      vars[key] = valueExpr.kind === ts.SyntaxKind.TrueKeyword;
      continue;
    }
    throw SchemaExtractionError.at(
      valueExpr,
      `config.vars.${key}`,
      '仅支持字符串/数字/布尔字面量（字符串含无插值模板字符串与 + 拼接）；嵌套对象/数组/null/标识符引用/含插值模板字符串无法静态求值',
      sourceFile,
    );
  }
  return vars;
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
 * 从表达式提取字符串数组（ArrayLiteralExpression，全元素静态可求值为字符串）
 *
 * - `['a', 'b']` → `['a', 'b']`
 * - `` [`a`, `b`] `` → `['a', 'b']`（无插值模板字符串元素）
 * - `['a' + 'b', 'c']` → `['ab', 'c']`（元素支持字面量拼接）
 * - `['a', someVar]` → `undefined`（含无法静态求值的元素）
 * - `[]` → `[]`（空数组）
 * - 非数组 → `undefined`
 */
function extractStringArrayValue(expr: ts.Expression): string[] | undefined {
  if (!ts.isArrayLiteralExpression(expr)) return undefined;
  const values: string[] = [];
  for (const element of expr.elements) {
    const value = extractStringValue(element);
    if (value === undefined) return undefined;
    values.push(value);
  }
  return values;
}
