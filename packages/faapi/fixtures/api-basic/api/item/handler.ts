// DELETE body 语义验证 fixture：DELETE 主输入是 query，body 参数应收到请求体；
// 声明 body 类型后走 DELETEBody schema 校验（Date 字段转换与 POST body 一致，
// 空请求体 undefined 跳过校验）
export interface ItemBody {
  id?: number;
  at?: Date;
}

export function DELETE(body: ItemBody) {
  return { deleted: body?.id ?? null, at: body?.at ?? null };
}
