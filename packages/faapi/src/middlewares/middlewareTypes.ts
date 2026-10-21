import type { FaapiContext } from '../runtime/contextTypes';

/**
 * faapi 中间件（洋葱模型）
 *
 * 单一 async 函数，通过 `await next()` 衔接前置/后置逻辑：
 * - `await next()` 之前的代码：前置处理（鉴权、日志开始计时等）
 * - `await next()` 之后的代码：后置处理（日志输出、响应修改等）
 * - 不调用 `next()` 即拦截请求（如鉴权失败直接返回 Response）
 * - `next()` 返回内层 Response，中间件可选择使用或替换
 * - 返回 `Response`：作为响应返回（可用于拦截或错误处理）
 * - 返回 `void`：使用 `await next()` 返回的内层响应
 *
 * 错误处理用 try/catch 包裹 `await next()`，而非独立的 error 钩子。
 *
 * 执行顺序（洋葱模型）：
 * ```
 * mw1.before → mw2.before → handler → mw2.after → mw1.after
 * ```
 *
 * 示例 middlewares.ts：
 * ```ts
 * import type { FaapiMiddleware } from '@faapi/faapi';
 *
 * export default [
 *   // 鉴权：不调 next() 即拦截
 *   async (ctx, next) => {
 *     const token = ctx.headers.get('authorization');
 *     if (!token) return new Response('Unauthorized', { status: 401 });
 *     ctx.user = await verifyToken(token);
 *     await next();
 *   },
 *   // 日志：before/after 一体，闭包共享状态
 *   async (ctx, next) => {
 *     const start = Date.now();
 *     await next();
 *     console.log(`${ctx.method} ${ctx.path} ${Date.now() - start}ms`);
 *   },
 *   // 错误处理：try/catch 语义
 *   async (ctx, next) => {
 *     try {
 *       await next();
 *     } catch (err) {
 *       return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
 *     }
 *   },
 * ] satisfies FaapiMiddleware[];
 * ```
 */
export type FaapiMiddleware = (
  ctx: FaapiContext,
  next: () => Promise<Response>,
) => Promise<void | Response>;
