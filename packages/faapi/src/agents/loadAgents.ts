import path from 'node:path';
import { importWithCacheBust } from '../utils/importWithCacheBust';
import type { AgentDeclaration, AgentMetadata, SystemPromptFactory } from './agentTypes';
import type { SerializedAgentRecord } from '../cli/generateAgentArtifacts';

/**
 * agent 声明启动期求值与校验（agent 声明运行时化的装载管线）
 *
 * 定位清单（[SerializedAgentRecord](../cli/generateAgentArtifacts.md)——仅 name /
 * filePath / inputTypeName 静态事实）→ 逐个动态 import handler 产物模块 → 求值
 * `config` 导出（对象或返回对象的函数）→ 逐字段启动期校验（fail-fast，错误带
 * handler 文件路径）→ 清单级校验（重名 / agents 引用存在性）→ hydrate 注册表。
 *
 * 单 agent 由此获得完整动态能力：systemPrompt 工厂函数（每次 run 求值）、
 * tools/agents/vars 注册时静态求值。
 */

/** handler.ts `config` 导出的合法字段白名单（未知字段启动期抛错——静默忽略会掩盖拼写错误） */
const KNOWN_CONFIG_FIELDS = [
  'description',
  'systemPrompt',
  'systemPromptFile',
  'tools',
  'agents',
  'maxTurns',
  'inputDescription',
  'vars',
] as const;

/**
 * 历史已移除的 config 字段（豁免白名单、静默忽略）——不做残留检测报错（维护者
 * 决策 2026-10-28：历史残留静默无效即终态，见根目录 HISTORY.md 1.1）。拼写错误
 * 防护只对全新未知字段生效，不追溯历史字段名。
 */
const LEGACY_CONFIG_FIELDS = ['model'] as const;

/** handler 模块的运行时形态（config 导出 + run 迁移检测） */
interface AgentHandlerModule {
  config?: unknown;
  run?: unknown;
}

/**
 * 求值单个 handler 模块的 `config` 导出为 AgentMetadata
 *
 * - `config` 为对象字面量 → 直接采用；为函数 → 调用求值（返回对象）——业务可
 *   用闭包/env 组装声明
 * - `run` 导出不被读取（agent 为声明式执行，编排场景注册 tool）
 * - 逐字段类型校验（白名单 / 互斥必填 / 元素类型 / 数值范围），全部 fail-fast
 *   抛错，错误信息带 `agent "<name>" (<filePath>)` 定位
 *
 * @param mod 动态 import 的 handler 模块命名空间
 * @param locator 定位信息（name 来自目录推导，filePath 为产物形式路径；
 *   inputTypeName 为构建期 Input 检测的静态事实——类型编译期擦除，仅存于定位清单）
 */
export function evaluateAgentDeclaration(
  mod: AgentHandlerModule,
  locator: { name: string; filePath: string; inputTypeName?: string },
): AgentMetadata {
  const where = `agent "${locator.name}" (${locator.filePath})`;

  if (mod.config === undefined) {
    throw new Error(
      `[faapi] ${where}: 缺少 config 导出——请在 handler.ts 声明 export const config = { ... }`,
    );
  }

  let decl: unknown = mod.config;
  if (typeof decl === 'function') {
    decl = (decl as () => unknown)();
  }
  if (typeof decl !== 'object' || decl === null || Array.isArray(decl)) {
    throw new Error(
      `[faapi] ${where}: config 必须是对象或返回对象的函数——got ${describeValue(decl)}`,
    );
  }
  const declaration = decl as Record<string, unknown>;

  for (const key of Object.keys(declaration)) {
    if ((LEGACY_CONFIG_FIELDS as readonly string[]).includes(key)) continue; // 历史字段静默忽略
    if (!(KNOWN_CONFIG_FIELDS as readonly string[]).includes(key)) {
      throw new Error(
        `[faapi] ${where}: 未知 config 字段 "${key}"——仅支持 ${KNOWN_CONFIG_FIELDS.join(' / ')}`,
      );
    }
  }

  // systemPrompt / systemPromptFile 互斥且二选一必填（提示词是 agent 的最小必需声明）
  const hasPrompt = declaration.systemPrompt !== undefined;
  const hasPromptFile = declaration.systemPromptFile !== undefined;
  if (hasPrompt && hasPromptFile) {
    throw new Error(`[faapi] ${where}: systemPrompt 与 systemPromptFile 互斥——请二选一声明`);
  }
  if (!hasPrompt && !hasPromptFile) {
    throw new Error(
      `[faapi] ${where}: 必须声明 systemPrompt（字符串或工厂函数）或 systemPromptFile（相对 resources 目录的路径）二选一`,
    );
  }
  if (
    hasPrompt &&
    typeof declaration.systemPrompt !== 'string' &&
    typeof declaration.systemPrompt !== 'function'
  ) {
    throw new Error(
      `[faapi] ${where}: systemPrompt 必须是 string 或工厂函数——got ${describeValue(declaration.systemPrompt)}`,
    );
  }
  if (hasPromptFile && typeof declaration.systemPromptFile !== 'string') {
    throw new Error(
      `[faapi] ${where}: systemPromptFile 必须是 string——got ${describeValue(declaration.systemPromptFile)}`,
    );
  }

  if (declaration.description !== undefined && typeof declaration.description !== 'string') {
    throw new Error(
      `[faapi] ${where}: description 必须是 string——got ${describeValue(declaration.description)}`,
    );
  }
  if (
    declaration.inputDescription !== undefined &&
    typeof declaration.inputDescription !== 'string'
  ) {
    throw new Error(
      `[faapi] ${where}: inputDescription 必须是 string——got ${describeValue(declaration.inputDescription)}`,
    );
  }
  if (declaration.tools !== undefined) {
    assertStringArray(declaration.tools, 'tools', where);
  }
  if (declaration.agents !== undefined) {
    assertStringArray(declaration.agents, 'agents', where);
  }
  if (declaration.maxTurns !== undefined) {
    const v = declaration.maxTurns;
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      throw new Error(`[faapi] ${where}: maxTurns 必须是有限正数——got ${describeValue(v)}`);
    }
  }
  if (declaration.vars !== undefined) {
    assertPlainVars(declaration.vars, where);
  }

  const d = declaration as AgentDeclaration;
  const metadata: AgentMetadata = {
    name: locator.name,
    filePath: locator.filePath,
    // 构建期 Input 检测的静态事实（zod.js 已生成 + 派发富 schema 判据）——
    // 类型编译期擦除，config 求值拿不到，只能从定位清单透传
    ...(locator.inputTypeName !== undefined ? { inputTypeName: locator.inputTypeName } : {}),
    ...(d.description !== undefined ? { description: d.description } : {}),
    ...(d.systemPrompt !== undefined
      ? { systemPrompt: d.systemPrompt as string | SystemPromptFactory }
      : {}),
    ...(d.systemPromptFile !== undefined ? { systemPromptFile: d.systemPromptFile } : {}),
    ...(d.tools !== undefined ? { tools: d.tools } : {}),
    ...(d.agents !== undefined ? { agents: d.agents } : {}),
    ...(d.maxTurns !== undefined ? { maxTurns: d.maxTurns } : {}),
    ...(d.inputDescription !== undefined ? { inputDescription: d.inputDescription } : {}),
    ...(d.vars !== undefined ? { vars: d.vars } : {}),
  };
  return metadata;
}

/**
 * 清单级校验：跨 agent 组合才暴露的问题，静默水合会让注册表处于与声明意图不符的状态
 *
 * - **agent 名重复**——hydrate 语义是后者覆盖前者，静默覆盖丢失 agent
 * - **`agents` 引用不存在的 agent 名**——sub-agent 递归到运行时首次调用才失败，
 *   错误被推迟且不带启动上下文
 *
 * `tools` 引用不做启动期校验——业务方 plugin 可在运行时注册额外 tool
 * （`PluginContext.registries`），启动期校验会误报。
 */
export function validateAgentDeclarations(agents: AgentMetadata[]): void {
  const names = new Map<string, string>();
  for (const a of agents) {
    const prev = names.get(a.name);
    if (prev) {
      throw new Error(
        `[faapi] agent 名重复: "${a.name}"（${prev} 与 ${a.filePath} 冲突——目录推导名撞名）`,
      );
    }
    names.set(a.name, a.filePath);
  }

  for (const a of agents) {
    for (const ref of a.agents ?? []) {
      if (!names.has(ref)) {
        const available = [...names.keys()].join(', ') || '无';
        throw new Error(
          `[faapi] agent "${a.name}" 的 agents 引用了不存在的 agent: "${ref}"（清单中可用: ${available}）`,
        );
      }
    }
  }
}

/**
 * 完整装载：定位清单 → 逐个动态 import → 求值 → 校验 → hydrate
 *
 * 定位清单与 handler 产物模块都经 `importWithCacheBust`（dev reload 时外层
 * setLoadTimestamp 已更新——两个 import 都必须 bust，否则改 config 后 reload
 * 拿到旧模块）。handler 内部 import 的第三方/业务共享模块保持 Node 缓存
 * （与路由 handler 现状一致，不扩大语义）。
 *
 * @param rootDir 项目根目录
 * @param dist 产物目录（定位清单 filePath 相对其解析）
 * @param locators 定位清单（faapi-agents.js 的 agents 数组；无 agent 项目为空数组）
 * @param registries 目标注册表（app 实例的 agent registry——窄接口，结构兼容
 *   AppRegistries 与测试设施的实例级注册表）
 * @returns 求值后的 AgentMetadata[]（供调用方日志/调试）
 */
export async function loadAndEvaluateAgents(
  rootDir: string,
  dist: string,
  locators: SerializedAgentRecord[],
  registries: { agent: { hydrate(agents: AgentMetadata[]): void } },
): Promise<AgentMetadata[]> {
  const loaded: AgentMetadata[] = [];
  for (const locator of locators) {
    const absPath = path.resolve(rootDir, locator.filePath);
    const mod = (await importWithCacheBust(absPath)) as AgentHandlerModule;
    loaded.push(evaluateAgentDeclaration(mod, locator));
  }
  validateAgentDeclarations(loaded);
  registries.agent.hydrate(loaded);
  return loaded;
}

/** 值类型描述（错误信息用——简短标识实际形态，辅助定位声明错误） */
function describeValue(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function assertStringArray(v: unknown, field: string, where: string): void {
  if (!Array.isArray(v) || v.some((el) => typeof el !== 'string')) {
    throw new Error(`[faapi] ${where}: ${field} 必须是 string[]——got ${describeValue(v)}`);
  }
}

function assertPlainVars(v: unknown, where: string): void {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new Error(`[faapi] ${where}: vars 必须是平面对象——got ${describeValue(v)}`);
  }
  for (const [key, leaf] of Object.entries(v as Record<string, unknown>)) {
    const t = typeof leaf;
    if (t !== 'string' && t !== 'number' && t !== 'boolean') {
      throw new Error(
        `[faapi] ${where}: vars.${key} 必须是 string | number | boolean（平面对象，不支持嵌套）——got ${describeValue(leaf)}`,
      );
    }
  }
}
