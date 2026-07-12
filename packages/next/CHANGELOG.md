# @faapi/next

## 1.0.0

### Major Changes

- 首次发布 @faapi/next——Next.js + faapi 单进程单端口集成。通过 `wrapHandler`/`wrapUpgradeHandler` 包装请求处理：`/api/*` 走 faapi，其余路径走 Next.js（含 HMR）。在 `faapi.config.ts` 的 `plugins` 字段声明即可加载。配置选项：`dev`/`dir`/`apiPrefix`。
