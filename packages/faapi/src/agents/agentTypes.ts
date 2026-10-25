import type { ReminderSpec } from '../configs/configTypes';

/**
 * agent 清单记录（定位清单条目）
 *
 * 由 [scanAgents](./scanAgents.md) 扫描文件系统生成，描述一个 agent 的定位信息。
 * 与 [ToolManifest](../tools/toolTypes.md) 对称——一个目录一个 agent，handler.ts
 * 导出 `config` 块。
 *
 * agent 名来自目录路径推导（如 `src/agents/researcher/handler.ts` → `researcher`，
 * 嵌套段用 `_` 连接）。
 *
 * agent 统一为声明式执行（config + 默认 reactLoop）——自定义 `run` 导出已移除，
 * 检测到 `run` 导出在启动期求值阶段抛迁移错误（编排场景注册 tool）。
 *
 * > `hasConfig` / `hasRun` 字段已移除——自定义 run 机制已整体移除。
 */
export interface AgentManifest {
  /** agent 名（目录路径推导，如 `researcher`） */
  name: string;
  /** 源码相对路径，如 `src/agents/researcher/handler.ts` */
  filePath: string;
}

export type AgentManifestList = AgentManifest[];

/**
 * 系统提示词工厂函数——每次 run 求值
 *
 * 与 `systemPromptFile`「每次 run 读文件」语义对齐：按 env/DB 等运行时状态
 * 切换人设时用工厂形态。返回非 string 在 run 期抛 `AgentError`（启动期无法
 * 验证返回类型）。
 */
export type SystemPromptFactory = () => string | Promise<string>;

/**
 * Agent 的 LLM 可见核心字段（启动期求值后的声明形态）
 *
 * 描述"agent 是什么"——LLM 真正需要消费的字段,**不含**声明文件定位信息
 * (filePath)。文件型 agent 与 DB-driven skill 都实现此接口。
 *
 * - 文件型 agent:由 [AgentMetadata](./agentTypes.md) 继承扩展,
 *   额外含 `filePath`(声明文件定位用)
 * - DB-driven skill:业务方 plugin 从 DB 字段映射到本接口即可,无需填占位值
 *   (skill 无源文件,自然不读 filePath)
 *
 * `@faapi/agent` 子包的 `Agent` 类、`agentRegistry` 查询入口、`asTool` 包装
 * 都消费 `AgentCore`,实现"agent 与 skill 走同一运行时链路"。
 *
 * 字段求值时机（启动期运行时求值语义,替代旧 AST 字面量提取）：
 * - `systemPrompt` 工厂函数 / `reminders` builders——每次 run（/每轮）求值
 * - `tools` / `agents` / `vars` / `maxTurns` / `description` / `inputDescription`
 *   ——启动期注册时一次求值,仅接受静态值（注册表拓扑数据 + 快照可克隆）
 */
export interface AgentCore {
  /** agent 名(目录路径推导值,嵌套段用 `_` 连接) */
  name: string;
  /** agent 描述(对 LLM 可见),由 config.description 声明,未声明为 `undefined` */
  description?: string;
  /**
   * 系统提示词,支持两种形态:
   * - `string`——静态提示词
   * - `SystemPromptFactory`——每次 run 求值(返回非 string 抛 `AgentError`)
   *
   * 文件型 agent 必填(启动期校验),与 `systemPromptFile` 互斥(二选一必填);
   * DB skill 由业务方自治
   */
  systemPrompt?: string | SystemPromptFactory;
  /**
   * 系统提示词文件路径,相对产物 resources 目录
   * (`<dist>/resources/`,运行时经免传参 `readResource` 读取),与 `systemPrompt` 互斥
   * (都声明启动期抛错,二选一必填)
   *
   * 运行时每次 run 读文件内容作为 systemPrompt——dev 改 prompt 文件经 watcher
   * 增量复制后立即生效,无需 reload;`deps.resourcesDir` 未注入或文件读取失败
   * 时抛 `AgentError`(不静默降级)
   */
  systemPromptFile?: string;
  /** agent 显式声明可用的 tool 引用列表,未声明时为 `undefined`;注册时静态求值(拓扑数据) */
  tools?: string[];
  /** 可调用的其他 agent 名列表,未声明时为 `undefined`;注册时静态求值(拓扑数据,启动期校验引用存在性) */
  agents?: string[];
  /** 最大对话轮数,未声明时为 `undefined`;声明了但非有限正数在启动期抛错 */
  maxTurns?: number;
  /**
   * agent-as-tool 派发交接单说明,未声明时为 `undefined`
   *
   * 该 agent 被其他 agent 当 tool 派发时(`agents` 列表引用),工具 `input` 字段的
   * schema description——告诉主控 LLM 该传什么样的交接单;未声明时 `@faapi/agent`
   * 的 `buildToolDefinitions` 用框架默认文案
   */
  inputDescription?: string;
  /**
   * 提示词模板变量(注册时求值的静态平面对象),未声明时为 `undefined`
   *
   * 声明后 agent 的 systemPrompt / systemPromptFile 内容中的 `{{key}}` 占位符在
   * 每次 run / sub-agent 派发时按 vars 渲染(工厂函数返回值同样渲染——先解析
   * 后渲染);未声明时提示词原样使用。运行时渲染见 `@faapi/agent` 的 promptTemplate.md
   */
  vars?: Record<string, string | number | boolean>;
  /**
   * 提醒注入——完整 [ReminderSpec] 形态(与全局声明面 `config.agent.reminders` 同构:
   * string | builder 函数 | { when, content } 对象),未声明时为 `undefined`
   *
   * string 默认 once(首轮持久注入)、函数默认 everyTurn(每轮刷新)、对象形式显式
   * `when` 覆盖;builder 每次渲染求值(见 `@faapi/agent` 的 reminders.md)。
   * 与全局声明面合并时排在其后(更靠近上下文末端)
   */
  reminders?: ReminderSpec[];
}

/**
 * Agent 完整元数据(文件型 agent)
 *
 * 继承 [AgentCore](./agentTypes.md) 的声明字段,额外扩展声明文件定位:
 * - `filePath` — 声明文件定位(启动日志 / 清单可观测性用)
 *
 * agent 统一为声明式执行(config + 默认 reactLoop)——自定义 `run` 导出已移除,
 * 检测到 run 导出在启动期求值阶段抛迁移错误(编排场景注册 tool)。
 *
 * DB-driven skill 不实现此接口(无源文件),只实现 `AgentCore`。
 *
 * 由启动期求值管线([loadAgents](./loadAgents.md))从定位清单
 * ([AgentManifest](./agentTypes.md))逐个动态 import handler 模块求值 `config`
 * 导出产出。
 */
export interface AgentMetadata extends AgentCore {
  /** 声明文件定位路径(产物形式,如 `dist/agents/researcher/handler.js`) */
  filePath: string;
  /**
   * 派发入参 schema 声明(handler.ts 顶层 `interface Input` / `type Input` 检测,
   * 构建期正则检测——类型编译期擦除,运行时不可反射)
   *
   * 声明时为 `'Input'`——[generateAgentArtifacts](../cli/generateAgentArtifacts.md)
   * 据此生成 agent 的 zod.js,`@faapi/agent` 派发该 agent 时用富 JSON Schema 替代
   * 默认单字段 `input` 交接单并在执行前校验;未声明为 `undefined`,派发行为不变
   * (完全向后兼容)。DB-driven skill 无源文件,恒为 `undefined`。
   */
  inputTypeName?: string;
}

/**
 * handler.ts `config` 导出契约
 *
 * agent handler 模块 `export const config = {...}`(或导出返回对象的函数)的
 * 类型形态——业务侧 `satisfies AgentDeclaration` 获得字段校验。与
 * [AgentCore](./agentTypes.md) 字段一致(仅少 `name`——由目录路径推导)。
 */
export interface AgentDeclaration {
  /** agent 描述(对 LLM 可见)——替代旧 JSDoc 提取 */
  description?: string;
  /** 系统提示词(静态串或每次 run 求值的工厂函数) */
  systemPrompt?: string | SystemPromptFactory;
  /** 系统提示词文件路径(与 systemPrompt 互斥) */
  systemPromptFile?: string;
  /** tool 引用列表(启动期静态求值) */
  tools?: string[];
  /** 可调用的其他 agent 名列表(启动期校验引用存在性) */
  agents?: string[];
  /** 最大对话轮数 */
  maxTurns?: number;
  /** agent-as-tool 派发交接单说明 */
  inputDescription?: string;
  /** 提示词模板变量(静态平面对象) */
  vars?: Record<string, string | number | boolean>;
  /** 提醒注入(完整 ReminderSpec 形态:静态串/builder/对象) */
  reminders?: ReminderSpec[];
}
