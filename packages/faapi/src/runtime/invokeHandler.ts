import type { FaapiContext } from './contextTypes';
import type { ResponseMeta } from './contextTypes';
import type { SseWriter } from './sse';
import type { FaapiMiddleware } from '../middleware/middlewareTypes';
import type { InjectorMap } from '../middleware/injectorTypes';
import { toResponse } from '../response/toResponse';
import { injectParamsAsync } from '../injection/injectParams';

/**
 * 将 ctx.meta（setStatus/setHeader/setCookie 设置的响应元数据）合并到 Response
 *
 * 用于中间件返回 Response 时，确保用户通过 ctx.setStatus/setHeader 设置的
 * 状态码、响应头、cookie 能正确附加到中间件返回的 Response 上。
 */
export function mergeMeta(response: Response, meta: ResponseMeta): Response {
  const hasMeta =
    meta.status !== undefined || Object.keys(meta.headers).length > 0 || meta.setCookies.length > 0;
  if (!hasMeta) return response;

  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(meta.headers)) {
    headers.set(key, value);
  }
  for (const cookie of meta.setCookies) {
    headers.append('set-cookie', cookie);
  }
  return new Response(response.body, {
    status: meta.status ?? response.status,
    headers,
  });
}

/**
 * 洋葱模型调度：将中间件链包装成 next 函数
 *
 * 每个中间件的 `await next()` 会执行下一个中间件并返回其 Response；
 * 最内层的 next 执行 handler（含参数注入）。
 *
 * 中间件返回 Response 的语义：
 * - 在 await next() 之前返回：拦截请求（不执行后续中间件和 handler）
 * - 在 await next() 之后返回：替换内层返回的响应
 * - 在 catch 块中返回：作为错误响应
 *
 * 中间件返回 void/undefined：使用 await next() 返回的内层响应。
 * 中间件不调用 next() 也不返回 Response：抛错（语义模糊，禁止使用）。
 *
 * 中间件返回 Response 时会合并 ctx.meta（setStatus/setHeader/setCookie 的设置），
 * 确保 ctx 便捷方法在中间件拦截场景下也生效。
 */
export async function compose(
  middlewares: FaapiMiddleware[],
  ctx: FaapiContext,
  finalHandler: () => Promise<Response>,
): Promise<Response> {
  const meta = (ctx as FaapiContext & { meta: ResponseMeta }).meta;
  let index = -1;

  async function dispatch(i: number): Promise<Response> {
    if (i <= index) {
      throw new Error('next() called multiple times');
    }
    index = i;

    // 所有中间件执行完，运行 handler
    if (i >= middlewares.length) {
      return await finalHandler();
    }

    const mw = middlewares[i];
    // next() 返回内层 Response，中间件可选择使用或替换
    let innerResponse: Response | undefined;
    const next = async (): Promise<Response> => {
      innerResponse = await dispatch(i + 1);
      return innerResponse;
    };

    const result = await mw(ctx, next);

    // 中间件返回 Response：使用它（拦截或替换），并合并 ctx.meta
    if (result instanceof Response) {
      return mergeMeta(result, meta);
    }
    // 中间件返回 void：使用 next() 返回的内层响应
    if (innerResponse !== undefined) {
      return innerResponse;
    }
    // 中间件既没返回 Response 也没调用 next()：语义模糊，禁止
    throw new Error('中间件必须 await next() 或返回 Response');
  }

  return await dispatch(0);
}

/**
 * 调用路由 handler 并将返回值转为 Response
 *
 * 流程（洋葱模型）：
 * 1. 中间件按洋葱模型执行：mw1.before → mw2.before → ... → handler → ... → mw2.after → mw1.after
 * 2. 中间件不调用 next() 即拦截请求（必须返回 Response）
 * 3. 中间件可用 try/catch 捕获内层错误
 * 4. 最内层执行注入器（按需）→ handler
 *
 * 注入器与中间件解耦：
 * - 注入器按 handler 参数名匹配，只执行需要的
 * - 注入器可读取中间件塞进 ctx 的值
 */
export async function invokeHandler(
  handler: (...args: unknown[]) => unknown,
  ctx: FaapiContext,
  body?: unknown,
  middlewares?: FaapiMiddleware[],
  injectors?: InjectorMap,
): Promise<Response> {
  const meta = (ctx as FaapiContext & { meta: ResponseMeta }).meta;

  /**
   * 若 handler 调用了 ctx.sse()，优先使用 SSE Response
   * （handler 返回值被忽略，SSE 流由 writer 控制）
   *
   * 同时执行自动 close 兜底：若 handler 返回时 writer 仍未关闭，自动调用 close()，
   * 避免连接泄漏。handler 异步循环未退出、忘记 close、或抛错的场景由这里兜底。
   */
  const pickSseAndAutoClose = (): Response | null => {
    const sseWriter = (ctx as FaapiContext & { __sseWriter?: SseWriter }).__sseWriter;
    if (!sseWriter) return null;
    // 兜底：handler 未显式 close 时自动关闭
    if (!sseWriter.closed && !sseWriter.aborted) {
      sseWriter.close();
    }
    return mergeMeta(sseWriter.response, meta);
  };

  // 抛错时也保证 writer 被关闭（避免流泄漏）
  const autoCloseSseOnError = (): void => {
    const sseWriter = (ctx as FaapiContext & { __sseWriter?: SseWriter }).__sseWriter;
    if (sseWriter && !sseWriter.closed && !sseWriter.aborted) {
      sseWriter.close();
    }
  };

  // 无中间件：直接执行 handler
  if (!middlewares || middlewares.length === 0) {
    try {
      const result = await injectParamsAsync(handler, ctx, body, injectors);
      const sseResponse = pickSseAndAutoClose();
      if (sseResponse) return sseResponse;
      return toResponse(result, meta);
    } catch (err) {
      // handler 抛错时关闭未完成的 SSE 流，避免泄漏
      autoCloseSseOnError();
      throw err;
    }
  }

  // 有中间件：洋葱模型调度
  const finalHandler = async (): Promise<Response> => {
    try {
      const result = await injectParamsAsync(handler, ctx, body, injectors);
      const sseResponse = pickSseAndAutoClose();
      if (sseResponse) return sseResponse;
      return toResponse(result, meta);
    } catch (err) {
      // handler 抛错时关闭未完成的 SSE 流，避免泄漏
      autoCloseSseOnError();
      throw err;
    }
  };

  return await compose(middlewares, ctx, finalHandler);
}
