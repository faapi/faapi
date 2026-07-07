import type { FaapiContext } from '../runtime/contextTypes';
import type { InjectorMap } from '../middleware/injectorTypes';
import { resolveInjection, type InjectionType } from './resolveInjection';
import { queryToObject } from '../utils/queryToObject';
import type { MultipartResult } from '../utils/parseMultipart';

/**
 * 根据注入类型获取对应的值（内置）
 */
function getBuiltinInjectionValue(type: InjectionType, ctx: FaapiContext, body?: unknown): unknown {
  switch (type) {
    case 'query':
      return queryToObject(ctx.query);
    case 'params':
      return ctx.params;
    case 'headers':
      return ctx.headers;
    case 'context':
      return ctx;
    case 'cookies':
      return ctx.cookies;
    case 'ip':
      return ctx.ip;
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
        return await injectors[injection.name](ctx);
      }
      return undefined;
    }),
  );

  return await handler(...args);
}
