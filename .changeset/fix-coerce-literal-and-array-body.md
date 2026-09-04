---
'@faapi/faapi': patch
---

修复两处参数校验正确性问题：

- **数字/布尔字面量的 query 校验不再必然失败**：query/params 声明 `status: 1 | 2` 这类字面量（联合）时，URL 传来的是字符串 `"1"`，此前裸 `z.literal(1)` 必然校验失败。现在 coerce 模式下数字/布尔字面量（含 union 成员级）自动包 `z.preprocess` 做字符串转换；混合联合（`'active' | 1`）中仅数字/布尔成员包裹，string 字面量天然命中
- **数组 body 不再被静默替换为 `{}`**：`type POSTBody = string[]` 生成的 schema 是 `z.array`，但运行时校验前数组输入被替换为 `{}`，导致合法数组 body 永远校验失败且 issue 误导为 `received object`；无 schema 时数组 body 也会被静默吞掉。现在校验输入与校验结果均原样透传，数组/顶层原始值 body（如 `type POSTBody = string`）正常工作
