---
"@faapi/next": patch
---

修复 Next 16 下 trustHostHeader 自动开启恒失败（无法加载 Next 内部 config 模块）的问题。

插件为 ESM，Node 的 ESM 解析器不补全扩展名，`import('next/dist/server/config')`（不带 `.js`）恒抛 `ERR_MODULE_NOT_FOUND`；且 Next 16 的 config.js 带 `__esModule` 编译标记，`loadConfig` 位于互操作后的第二层 `default`，旧取值逻辑拿到的是对象而非函数。两处叠加导致加载必败、catch 恒触发，警告文案还引导用户手写 `experimental.trustHostHeader`——而 Next 16 的 config schema 已移除该字段，手写又触发 `Unrecognized key(s)` 告警，形成死循环。

修复内容：

- 内部模块 import 全部带 `.js` 扩展名，并按候选列表回退（`next/dist/server/config.js` → `next/dist/esm/server/config.js`；`next/constants.js` → `next/constants`）
- `loadConfig` 解析兼容三种模块形态：ESM default / CJS `module.exports = fn` / Next 16 的 CJS `module.exports.default = fn`（两层 default）
- 失败警告不再引导手写该字段，改为提示 Next 16+ schema 会拒绝手写、可用插件选项 `trustHostHeader: false` 关闭提示
