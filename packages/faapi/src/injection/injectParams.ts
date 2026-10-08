import type { FaapiContext } from '../runtime/contextTypes';
import type { InjectorMap } from '../middleware/injectorTypes';
import { resolveInjection, type InjectionType } from './resolveInjection';
import type { MultipartResult } from '../utils/parseMultipart';
import { listAgents } from './agentRegistry';
import { getAgentHandle } from './agentHandle';

/**
 * 根据注入类型获取对应的值（内置）
 *
 * Phase 2.3 扩展 `agent` / `agents`：
 * - `agents` → `listAgents()`（所有已注册 agent 元数据列表）
 * - `agent` → `getAgentHandle(ctx)`（Phase 3.5：调 `@faapi/agent` 插件注册的工厂）
 *
 * Phase 3.5 的 `@faapi/agent` 插件通过 [agentHandle](./agentHandle.md) 工厂注册机制
 * 提供 `AgentHandle`（含可调用 `run` / `stream`）。未注册工厂时返回 `undefined`。
 */
function getBuiltinInjectionValue(type: InjectionType, ctx: FaapiContext, body?: unknown): unknown {
  switch (type) {
    case 'query':
      // ctx.query 与管线校验挂载的是同一对象：声明 query 类型时为转换值
      //（number/boolean 字段已 coerce，未声明字段保留原始字符串），未声明时
      // 为原始 query 对象（createContext 挂载后管线不触及）
      return ctx.query;
    case 'params':
      // 路径参数：管线已按声明类型校验并回写 ctx.params（转换后的值），
      // 未声明 params 类型的路由保持原始字符串
      return ctx.params;
    // raw 系：恒原始，管线永不覆盖（ctx 字段即注入值）
    case 'rawQuery':
      return ctx.rawQuery;
    case 'rawParams':
      return ctx.rawParams;
    case 'rawBody':
      return ctx.rawBody;
    case 'headers':
      return ctx.headers;
    case 'context':
      return ctx;
    case 'cookies':
      return ctx.cookies;
    case 'ip':
      return ctx.ip;
    case 'ua':
      return ctx.ua;
    case 'body':
      return body;
    // form 与 body 共享解析结果（resolveInput 已按 Content-Type 解析 form-urlencoded）
    // 差异仅在 schema 校验（form coerce=true，由 collectRouteSchemaSources 标记）
    case 'form':
      return body;
    case 'files':
      if (body && typeof body === 'object' && 'files' in body) {
        return (body as MultipartResult).files;
      }
      return [];
    case 'fields':
      if (body && typeof body === 'object' && 'fields' in body) {
        return (body as MultipartResult).fields;
      }
      return {};
    // Phase 2.3：注入所有已注册 agent 元数据列表
    // 方案 A：优先读 app 实例注册表，无实例（编程式直调 ctx）回退默认全局实例
    case 'agents':
      return ctx.registries ? ctx.registries.agent.listAgents() : listAgents();
    // Phase 3.5：调 @faapi/agent 插件注册的工厂获取 AgentHandle
    case 'agent':
      return ctx.registries ? ctx.registries.agentHandle.get(ctx) : getAgentHandle(ctx);
    // 任务子系统：注入 TaskClient（入队/查询）；未注册工厂（无 app 编排）时 undefined
    case 'tasks':
      return ctx.registries ? ctx.registries.taskHandle.get(ctx) : undefined;
    // 轻量 LLM 补全通道：@faapi/agent 插件注册到 registries.llm；与请求上下文无关，
    // get 无参。插件未加载（或编程式直调 ctx 无 registries）时 undefined
    case 'llm':
      return ctx.registries ? ctx.registries.llm.get() : undefined;
    // 请求级日志器：与 ctx.log 同一实例（scope http，自动带 requestId/method/path 字段）
    case 'log':
      return ctx.log;
    default:
      return undefined;
  }
}

/**
 * 根据注入信息，准备参数值并调用 handler（异步版本）
 *
 * 支持 async handler。内置注入优先于注入器（避免 query/body 等被覆盖）。
 * 非内置参数从注入器注册表按参数名查找，按需执行。
 */
export async function injectParamsAsync(
  handler: (...args: unknown[]) => unknown,
  ctx: FaapiContext,
  body?: unknown,
  injectors?: InjectorMap,
): Promise<unknown> {
  const injections = resolveInjection(handler);

  if (injections.length === 0) {
    return await handler();
  }

  const args = await Promise.all(
    injections.map(async (injection) => {
      // 内置注入优先
      if (injection.type !== 'unknown') {
        return getBuiltinInjectionValue(injection.type, ctx, body);
      }
      // 注入器按参数名匹配
      if (injectors && injection.name in injectors) {
        // in 检查已证明存在
        return await injectors[injection.name]!(ctx);
      }
      return undefined;
    }),
  );

  return await handler(...args);
}
