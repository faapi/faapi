import type { FaapiContext } from '../runtime/contextTypes';

/**
 * 注入器：按参数名匹配，提供 handler 所需的依赖
 *
 * 注入器是 faapi 的依赖注入扩展点，与中间件解耦：
 * - 中间件只管请求流程（鉴权、日志、错误处理）
 * - 注入器只管提供依赖（数据库连接、用户对象等）
 *
 * 注入器可以读取中间件塞进 ctx 的值（如鉴权中间件塞的 ctx.user），
 * 也可以独立提供依赖（如数据库连接池）。
 *
 * 注入器按需执行：只对 handler 声明的参数执行对应的注入器，避免无谓计算。
 *
 * 在 middlewares.ts 中通过命名导出 `injectors` 注册：
 * ```ts
 * import type { InjectorMap } from '@faapi/faapi';
 *
 * export const injectors: InjectorMap = {
 *   db: () => getDbConnection(),
 *   user: (ctx) => ctx.user,  // 取中间件塞的值
 * };
 * ```
 */
export type Injector = (ctx: FaapiContext) => unknown | Promise<unknown>;

/**
 * 注入器映射表：参数名 → 注入器函数
 *
 * key 必须与 handler 参数名一致，运行时按参数名匹配执行。
 */
export type InjectorMap = Record<string, Injector>;
