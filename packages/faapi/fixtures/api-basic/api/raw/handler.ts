// raw 系字段验证 fixture（一）：query 口径——ctx.query 为转换后对象（与 handler
// 注入同一对象），rawQuery 为原始 URLSearchParams（恒不被转换值覆盖）
export interface RawQuery {
  page: number;
}

export function GET(
  ctx: import('@faapi/faapi').FaapiContext,
  query: RawQuery,
  rawQuery: URLSearchParams,
) {
  const c = ctx as unknown as Record<string, unknown>;
  return {
    // 注入 query 与 ctx.query 是同一对象（转换后口径全链路一致）
    sameObject: c.query === query,
    page: query.page,
    pageType: typeof query.page,
    ctxPageType: typeof (c.query as Record<string, unknown>)['page'],
    // rawQuery 恒为原始字符串
    rawPage: rawQuery.get('page'),
    rawPageType: typeof rawQuery.get('page'),
  };
}
