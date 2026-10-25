/**
 * callTool——经真实分发管线的 tool 测试辅助函数
 *
 * 直调 `mod.handler(input, ctx)` 的测试姿势完全绕过校验（`ToolModule.handler`
 * 类型为 `(...args: unknown[]) => unknown`，编译期流型检查失效；运行时零校验——
 * 业务字段缺失时 handler 拿到 undefined 静默执行，租户隔离在测试层穿底）。
 * 与 HTTP 路由测试走 createTestServer 真实管线对齐，tool 测试走本函数——
 * 经 `executeToolCall` 同一条生产分发链（input schema 校验 + ctx 声明即校验 +
 * handler 执行），ctx 装配错误在测试现场响亮抛错。
 *
 * harness（createAgentTestHarness）是唯一入口——`loadToolModule` 直调面已从
 * harness 移除。free-form 模式无 schema 可校验，调用即显式抛错（不静默放行）。
 *
 * 详见 [callTool.md](./callTool.md)。
 */

import path from 'node:path';
import { loadToolModule } from '@faapi/faapi';
import type { AgentToolContext } from '@faapi/faapi';
import type { AgentTestHarness } from '@faapi/faapi/testing';
import { executeToolCall, validateToolCtx, type AgentDeps } from './agent';

/**
 * 经 executeToolCall 真实分发管线调用 tool（测试辅助）
 *
 * @param harness `createAgentTestHarness` 产物（generated 模式——声明即校验依赖
 *   zod.js 产物，free-form 显式抛错）
 * @param name tool 名（路径推导名，如 `weather_getWeather`）
 * @param args tool 入参——input 校验失败时返回 `{ error }`（与 LLM 重试语义一致，
 *   原样返回可断言校验契约）
 * @param ctx tool 执行 ctx——业务字段经 `createStandaloneToolContext` 注入；
 *   tool 声明 ctxTypeName 时先做 ctx 装配预校验，失败**抛错**（测试 ctx 构造问题
 *   属编程错误，不得以 `{ error }` 静默返回让测试假绿）
 * @returns handler 结果（原样，不包装）
 */
export async function callTool(
  harness: AgentTestHarness,
  name: string,
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<unknown> {
  if (!harness.resolveToolSchema) {
    throw new Error(
      "callTool 需要 schemaMode: 'generated'（声明即校验依赖 zod.js 产物）——" +
        'free-form 模式无 schema 可校验，ctx/input 契约测试请改用 generated 模式',
    );
  }
  const tool = harness.registries.tool.get(name);
  if (!tool) {
    throw new Error(`Tool "${name}" not found`);
  }

  // ctx 装配预校验（与 executeToolCall 同一实现）：缺字段/错型在调用 handler 前
  // 响亮抛错——否则漏传 currentUserId 的测试照常假绿，租户隔离在测试层穿底
  const ctxError = await validateToolCtx(
    { resolveToolSchema: harness.resolveToolSchema },
    name,
    tool,
    ctx,
  );
  if (ctxError) throw new Error(ctxError);

  // 最小 AgentDeps 组装（providers/llms 非 executeToolCall 消费面，空装配）；
  // loadToolModule 桥接与生产同口径：registry 产物形式 filePath（临时目录前缀，
  // mkdtemp 为绝对 / 显式 dist 相对）转绝对后走主包 loader
  const deps: AgentDeps = {
    providers: new Map(),
    llms: {},
    rootDir: harness.rootDir,
    ctx,
    getAgent: harness.registries.agent.getAgent,
    getAgentEntry: harness.registries.agent.getAgentEntry,
    getTool: harness.registries.tool.get,
    resolveAgentTools: harness.registries.agent.resolveAgentTools,
    resolveSubAgents: harness.registries.agent.resolveSubAgents,
    loadToolModule: (filePath, functionName) =>
      loadToolModule(
        path.isAbsolute(filePath) ? filePath : path.resolve(harness.rootDir, filePath),
        functionName,
        harness.rootDir,
      ),
    resolveToolSchema: harness.resolveToolSchema,
  };
  return executeToolCall(deps, name, args, ctx);
}
