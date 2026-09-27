// DELETE body 语义验证 fixture：DELETE 主输入是 query，body 参数应收到请求体；
// 声明 body 类型后走 DELETEBody schema 校验（Date 字段转换与 POST body 一致，
// 空请求体 null 与 POST 同路径——有 schema 时 safeParse 失败 422）
export interface ItemBody {
  id?: number;
  at?: Date;
}

export function DELETE(ctx: import('@faapi/faapi').FaapiContext, body: ItemBody) {
  return {
    deleted: body?.id ?? null,
    at: body?.at ?? null,
    // ctx.body 与 body 注入是同一校验后对象
    ctxBodySame: (ctx as unknown as Record<string, unknown>).body === body,
  };
}
