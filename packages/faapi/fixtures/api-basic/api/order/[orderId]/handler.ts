// params/query 类型转换验证 fixture：路径段与 query 来源均为 string，
// schema 按声明类型 coerce——handler 应拿到 number/boolean 而非原始字符串
export interface OrderParams {
  orderId: number;
}

export interface OrderQuery {
  verbose: boolean;
  limit?: number;
}

export function GET(ctx: import('@faapi/faapi').FaapiContext, params: OrderParams, query: OrderQuery) {
  const raw = query as Record<string, unknown>;
  const c = ctx as unknown as Record<string, unknown>;
  return {
    orderId: params.orderId,
    orderIdType: typeof params.orderId,
    verbose: query.verbose,
    verboseType: typeof query.verbose,
    limit: query.limit ?? null,
    // 未在 OrderQuery 中声明的字段不被 schema 剥掉，保留原始字符串
    extra: raw['extra'] ?? null,
    // ctx.query 与注入 query 是同一对象（转换后口径全链路一致）
    ctxQuerySame: c.query === query,
    // ctx.params 与注入 params 是同一对象
    ctxParamsSame: c.params === params,
  };
}

export interface OrderCreateBody {
  title: string;
}

export function POST(
  ctx: import('@faapi/faapi').FaapiContext,
  params: OrderParams,
  body: OrderCreateBody,
) {
  const mwSaw = (ctx as unknown as {
    __orderMwSaw?: { orderIdType: string; bodyTitle: string | null };
  }).__orderMwSaw;
  return {
    orderId: params.orderId,
    orderIdType: typeof params.orderId,
    title: body.title,
    // 目录中间件先于 handler 执行，读到的 ctx.body 已是校验后的对象
    mwBodyTitle: mwSaw?.bodyTitle ?? null,
  };
}// DELETE 主输入是 query（与 GET 同分支）——验证 query 转换在 DELETE 上同样生效，
// 并回读目录中间件快照，锁住「中间件看到回写后 params」的管线顺序
export function DELETE(
  ctx: import('@faapi/faapi').FaapiContext,
  params: OrderParams,
  query: OrderQuery,
) {
  const mwSaw = (ctx as unknown as { __orderMwSaw?: { orderIdType: string } }).__orderMwSaw;
  const c = ctx as unknown as Record<string, unknown>;
  return {
    orderId: params.orderId,
    orderIdType: typeof params.orderId,
    verbose: query.verbose,
    verboseType: typeof query.verbose,
    mwOrderIdType: mwSaw?.orderIdType ?? null,
    // DELETE 无 body：ctx.body 恒 undefined
    ctxBodyUndefined: c.body === undefined,
  };
}
