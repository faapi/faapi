// raw 系字段验证 fixture（二）：params 口径——ctx.params 为转换后对象（与 handler
// 注入同一对象），rawParams / ctx.rawParams 恒为 URL 原始字符串
export interface RawIdParams {
  id: number;
}

export function GET(ctx: import('@faapi/faapi').FaapiContext, params: RawIdParams, rawParams) {
  const c = ctx as unknown as Record<string, unknown>;
  return {
    sameObject: c.params === params,
    id: params.id,
    idType: typeof params.id,
    // rawParams 注入恒为原始字符串
    rawId: rawParams['id'],
    rawIdType: typeof rawParams['id'],
    // ctx.rawParams 与注入 rawParams 是同一对象（恒原始）
    ctxRawParamsSame: c.rawParams === rawParams,
  };
}
