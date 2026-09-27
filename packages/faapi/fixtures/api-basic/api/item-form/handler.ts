// DELETE form-urlencoded 验证 fixture：DELETE 主输入是 query，声明 form 形参时
// 请求体按 form 解析并走 DELETEBody schema（coerce=true，number/boolean 字段转换）
export interface ItemForm {
  id: number;
  force?: boolean;
}

export function DELETE(form: ItemForm) {
  return {
    deleted: form.id,
    deletedType: typeof form.id,
    force: form.force ?? null,
    forceType: form.force === undefined ? null : typeof form.force,
  };
}
