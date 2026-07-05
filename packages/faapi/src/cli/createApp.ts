/**
 * createApp — createProdApp 的向后兼容别名
 *
 * `createApp` 历史上是 faapi 唯一的启动 API。拆分 dev/prod 后：
 * - `createProdApp`：prod 入口（精简，无 reloadRoutes），由 `dist/main.js` 内部调用
 * - `createDevApp`：dev 入口（含 reloadRoutes 热替换），由 `faapi dev` 直接调用
 * - `createApp`：保留为 `createProdApp` 的别名，供编程式调用场景使用
 *
 * 框架采用零入口设计——用户无需编写 main.ts：dev 由 `faapi dev` 内部编排，
 * prod 由 `faapi build` 自动生成 `dist/main.js` 启动入口。`createApp`/`createProdApp` 主要供自定义编程式启动场景使用。
 *
 * 新代码建议直接使用 `createProdApp`（语义更清晰）。
 */
export {
  createProdApp as createApp,
  type ProdApp as App,
  type CreateAppOptions,
} from './createProdApp';
