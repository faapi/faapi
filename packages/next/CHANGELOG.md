# @faapi/next

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
