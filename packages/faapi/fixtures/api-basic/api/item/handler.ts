// DELETE body 语义验证 fixture：DELETE 主输入是 query，body 参数应收到请求体
export function DELETE(body: { id?: number }) {
  return { deleted: body?.id ?? null };
}
