# @faapi/next

## 4.4.0

## 4.3.0

## 4.2.1

### Patch Changes

- cc5f783: 修复 Next 16 下 trustHostHeader 自动开启恒失败（无法加载 Next 内部 config 模块）的问题。

  插件为 ESM，Node 的 ESM 解析器不补全扩展名，`import('next/dist/server/config')`（不带 `.js`）恒抛 `ERR_MODULE_NOT_FOUND`；且 Next 16 的 config.js 带 `__esModule` 编译标记，`loadConfig` 位于互操作后的第二层 `default`，旧取值逻辑拿到的是对象而非函数。两处叠加导致加载必败、catch 恒触发，警告文案还引导用户手写 `experimental.trustHostHeader`——而 Next 16 的 config schema 已移除该字段，手写又触发 `Unrecognized key(s)` 告警，形成死循环。

  修复内容：

  - 内部模块 import 全部带 `.js` 扩展名，并按候选列表回退（`next/dist/server/config.js` → `next/dist/esm/server/config.js`；`next/constants.js` → `next/constants`）
  - `loadConfig` 解析兼容三种模块形态：ESM default / CJS `module.exports = fn` / Next 16 的 CJS `module.exports.default = fn`（两层 default）
  - 失败警告不再引导手写该字段，改为提示 Next 16+ schema 会拒绝手写、可用插件选项 `trustHostHeader: false` 关闭提示

## 4.2.0

## 4.1.0

## 4.0.0

### Patch Changes

- Updated dependencies [0337482]
- Updated dependencies [8947f46]
- Updated dependencies [eadf440]
- Updated dependencies
- Updated dependencies [981c99f]
- Updated dependencies [f60d137]
- Updated dependencies [f60d137]
- Updated dependencies [d822718]
- Updated dependencies [c18c62e]
- Updated dependencies [13c6297]
- Updated dependencies [6f2903f]
- Updated dependencies [b31a442]
- Updated dependencies [3c12dc6]
- Updated dependencies [4617c07]
- Updated dependencies [9d5865d]
- Updated dependencies [a0cb30c]
  - @faapi/faapi@4.0.0

## 3.3.0

## 3.2.1

## 3.2.0

## 3.1.0

## 3.0.0

### Patch Changes

- Updated dependencies [1d54523]
- Updated dependencies [1d54523]
- Updated dependencies [49d7ac9]
  - @faapi/faapi@3.0.0

## 2.0.1

## 2.0.0

### Patch Changes

- Updated dependencies [1258e39]
  - @faapi/faapi@2.0.0

## 1.5.0

## 1.4.0

### Minor Changes

- `@faapi/next` 默认自动开启 Next.js 的 `experimental.trustHostHeader`，解决反向代理（Nginx/Caddy 等）场景下 `initURL` 错误地构造为 `https://localhost:3000/path`、忽略代理透传 `Host` 头的问题。

  - 新增插件选项 `trustHostHeader`（默认 `true`），通过 Next.js 内部 `loadConfig` 加载用户 `next.config.ts` 并合并 `experimental.trustHostHeader = true`，再经 `next()` 的 `conf` 选项传入。
  - 用户 `next.config.ts` 中的其他配置（`images`/`rewrites`/`redirects` 等）会被完整保留；已显式开启时不重复设置；`loadConfig` 失败时降级为不传 `conf` 并打印警告。
  - 设为 `false` 可禁用此行为，由用户手动在 `next.config.ts` 中控制。

## 1.3.1

## 1.3.0

## 1.2.1

## 1.2.0

## 1.1.1

### Patch Changes

- 改进发布流程：通过 tag 区分 canary 和 stable 发布

## 1.1.0

### Patch Changes

- Updated dependencies [853a175]
  - @faapi/faapi@1.1.0

## 1.0.2

### Patch Changes

- Updated dependencies
  - @faapi/faapi@1.0.2

## 1.0.1

### Patch Changes

- Updated dependencies
  - @faapi/faapi@1.0.1

## 1.0.0

### Major Changes

- 首次发布 @faapi/next——Next.js + faapi 单进程单端口集成。通过 `wrapHandler`/`wrapUpgradeHandler` 包装请求处理：`/api/*` 走 faapi，其余路径走 Next.js（含 HMR）。在 `faapi.config.ts` 的 `plugins` 字段声明即可加载。配置选项：`dev`/`dir`/`apiPrefix`。
