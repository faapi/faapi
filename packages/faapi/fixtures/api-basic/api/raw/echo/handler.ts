// raw 系字段验证 fixture（三）：body 口径——rawBody 为原始请求体文本
//（JSON/form 均带出；multipart/GET 恒 undefined），ctx.body 与注入 body 同一
export interface EchoBody {
  title: string;
}

export function POST(ctx: import('@faapi/faapi').FaapiContext, body: EchoBody) {
  const c = ctx as unknown as Record<string, unknown>;
  return {
    title: body.title,
    // ctx.body 与注入 body 是同一校验后对象
    ctxBodySame: c.body === body,
    // rawBody 为原始请求体文本（未解析的 JSON 字符串）
    rawBodyType: typeof c.rawBody,
    rawBodyIsRawJson: c.rawBody === JSON.stringify(body),
  };
}

export function PUT(ctx: import('@faapi/faapi').FaapiContext, form: EchoBody) {
  const c = ctx as unknown as Record<string, unknown>;
  return {
    title: form.title,
    titleType: typeof form.title,
    // form 场景 rawBody 为原始 urlencoded 文本
    rawBody: c.rawBody,
  };
}
