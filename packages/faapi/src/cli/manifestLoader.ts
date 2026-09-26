import fs from 'node:fs';
import path from 'node:path';
import { hydrateTools, type SerializedToolRecord } from './generateToolArtifacts';
import { hydrateAgents, type SerializedAgentRecord } from './generateAgentArtifacts';
import { hydrateTasks, TASKS_FILE } from './generateTaskArtifacts';
import { importWithCacheBust } from '../utils/importWithCacheBust';
import { defaultRegistries, type AppRegistries } from '../injection/registries';
import type { ToolMetadata } from '../ast/extractToolMetadata';
import type { AgentMetadata } from '../ast/extractAgentMetadata';
import type { FaapiConfig } from '../config/configTypes';

/**
 * 产物清单加载与注册表水合
 *
 * 从 createAppCore 拆出的清单装载层：routes/tools/agents/tasks 四类产物的
 * 「读取 → 水合 → 灌入注册表」是同构流程，与 app 编排（server 创建/插件/生命周期）
 * 正交。dev reload* 的热替换也复用这些函数（setLoadTimestamp 由外层设置）。
 */

/** tool 清单文件名（build/dev 启动时生成，可选产物——无 tool 的项目不生成） */
const TOOLS_FILE = 'faapi-tools.js';
/** agent 清单文件名（build/dev 启动时生成，可选产物——无 agent 的项目不生成） */
const AGENTS_FILE = 'faapi-agents.js';

/**
 * 加载 faapi-tools.js 并水合到 toolRegistry（app 实例）
 *
 * 与路由清单不同，tool 是可选能力——纯 API 项目可能没有 `faapi-tools.js`，
 * 此时不报错，返回空数组，toolRegistry 保持空。
 *
 * dev 按需模式下 `reloadTools` 也会调用此函数重新水合（`setLoadTimestamp` 已在外层设置）。
 *
 * @returns 水合后的 ToolMetadata[]（供调用方日志/调试）
 */
export async function loadAndHydrateTools(
  rootDir: string,
  dist: string,
  registries: AppRegistries = defaultRegistries,
): Promise<ToolMetadata[]> {
  const toolsPath = path.resolve(rootDir, dist, TOOLS_FILE);
  if (!fs.existsSync(toolsPath)) {
    return [];
  }
  const serialized = (await importWithCacheBust(toolsPath)) as unknown as {
    tools: SerializedToolRecord[];
  };
  const hydrated = hydrateTools(serialized.tools ?? []);
  registries.tool.hydrate(hydrated);
  return hydrated;
}

/**
 * 加载 faapi-agents.js 并水合到 agentRegistry（app 实例）
 *
 * 与 `loadAndHydrateTools` 对称——agent 是可选能力,纯 API 项目可能没有 `faapi-agents.js`,
 * 此时不报错,返回空数组,agentRegistry 保持空。
 *
 * dev 按需模式下 `reloadAgents` 也会调用此函数重新水合（`setLoadTimestamp` 已在外层设置）。
 *
 * @returns 水合后的 AgentMetadata[]（供调用方日志/调试）
 */
export async function loadAndHydrateAgents(
  rootDir: string,
  dist: string,
  registries: AppRegistries = defaultRegistries,
): Promise<AgentMetadata[]> {
  const agentsPath = path.resolve(rootDir, dist, AGENTS_FILE);
  if (!fs.existsSync(agentsPath)) {
    return [];
  }
  const serialized = (await importWithCacheBust(agentsPath)) as unknown as {
    agents: SerializedAgentRecord[];
  };
  const hydrated = hydrateAgents(serialized.agents ?? []);
  registries.agent.hydrate(hydrated);
  return hydrated;
}

/**
 * 读取 config.task 中的驱动选项（pgboss/bullmq 的连接配置透传给驱动工厂）
 */
export function getTaskDriverOptions(config: FaapiConfig | null): unknown {
  if (!config?.task) return undefined;
  if (config.task.driver === 'pgboss') return config.task.pgboss;
  if (config.task.driver === 'bullmq') return config.task.bullmq;
  return undefined;
}

/**
 * 加载 faapi-tasks.js 并水合到 taskRegistry（app 实例）
 *
 * 与 `loadAndHydrateTools` 对称——任务是可选能力，无任务的项目清单为空数组，
 * taskRegistry 保持空，任务队列空转。
 *
 * @returns 水合后的 TaskMetadata[]（供调用方日志/调试）
 */
export async function loadAndHydrateTasks(
  rootDir: string,
  dist: string,
  registries: AppRegistries = defaultRegistries,
): Promise<ReturnType<typeof hydrateTasks>> {
  const tasksPath = path.resolve(rootDir, dist, TASKS_FILE);
  if (!fs.existsSync(tasksPath)) {
    return [];
  }
  const serialized = (await importWithCacheBust(tasksPath)) as unknown as {
    tasks: Parameters<typeof hydrateTasks>[0];
  };
  const hydrated = hydrateTasks(serialized.tasks ?? []);
  registries.task.hydrate(hydrated);
  return hydrated;
}
