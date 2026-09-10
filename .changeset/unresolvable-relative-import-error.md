---
'@faapi/faapi': minor
---

`faapi build`/`faapi dev` 对项目内无法解析的相对导入构建期直接报错，不再静默保留原样。此前笔误的相对导入（如 `'../../dao/call-logs'` 实际在 `'../../lib/dao/call-logs'`）会无告警通过构建，无后缀说明符原样进入产物，直到生产 Node ESM 严格解析时才报 `ERR_MODULE_NOT_FOUND`；现在构建期即失败并给出 file:line:column 与说明符文本。配套变化：specifier 定位核心从正则改为 TypeScript AST（注释与字符串字面量中的 `from '...'` 不再被误改误报）；副作用导入 `import './x'` 也被重写补 `.js` 后缀（原正则不覆盖，产物会带无后缀导入）；`.js` 说明符在对应产物文件不存在时回退探测 `.ts`/`.tsx`/`.jsx` 源（Node16 风格 `import './x.js'` 指向 `x.ts` 的常见写法不受影响）；`import type`/`export type` 被编译器擦除，不参与重写与报错。
