# bootstrap（src/bootstrap.ts 约定启动文件）

一句话概括：框架约定的启动文件——`createProdApp`/`createDevApp` 在 **app 创建之后、listen 之前**加载并执行它，业务在 `getApp().on(...)` 上完成全部事件订阅（含 `app:boot`/`app:ready`/`app:close` 三个启动期事件）。

## 为什么需要

事件订阅的唯一入口是 `getApp().on(...)`，但启动期事件在 `listen()` 内发射，而零入口模式下 CLI/生成入口把「创建 app」和「listen」连续执行——业务代码（config 顶层、handler 模块）没有一个执行点能落在两者之间。`src/bootstrap.ts` 由框架约定路径并在**正确的时机**加载：窗口由框架给出，订阅统一为一个 API。

## 使用场景

```ts
// src/bootstrap.ts —— 框架约定的启动文件（类比 faapi.config.ts 的地位）
import { getApp } from '@faapi/faapi';

export default async function bootstrap() {
  const app = getApp(); // ← 此刻 app 已创建、事件未发射，getApp() 可用

  app.on('app:boot', ({ server }) => {
    if (!process.env.DB_HOST) throw new Error('DB_HOST is required'); // 抛错 → 端口不暴露
  });
  app.on('app:ready', async ({ registries }) => {
    await initDb();
  });
  app.on('app:close', async () => {
    await closeDb();
  });
  app.on('agent:root-input', (e) => {
    e.addInput('[tenant:x] {{rawInput}}');
  });
}
```

运行期事件（agent 域 / `request:error` / `task:failed`）也可写在各自模块顶层 `getApp().on(...)`——app 运行中随时可订阅；启动期三事件**必须**写在本文件。

## 机制（loadBootstrap）

- **约定路径固定** `src/bootstrap.ts`（不进任何路由/tool/agent/task 扫描器）。
- **时序契约**：`createAppBase（app 已建、单例已设）→ loadBootstrap → 返回 app → 业务 listen()（app:boot → server.listen → app:ready）`。
- **dev 形态**（`createDevApp` 内部，`onDemand: true`）：探测 `src/bootstrap.ts` 存在 → `ensureCompiled`（依赖闭包 + mtime 缓存，与 agent handler 同款——覆盖 `import '../src/lib/xxx'`）编译到 `.faapi/bootstrap.js` → 动态 import → `await default()`。
- **prod 形态**（`createProdApp` 内部）：`faapi build` 的 `compileSourceFiles` 全量编译已产出 `dist/bootstrap.js`；探测存在 → 动态 import → `await default()`；源码比产物新（改了源码没重新 build）→ 抛错指引 `faapi build`。
- **可选性**：无 `src/bootstrap.ts` 的项目零开销跳过。
- **抛错语义**：bootstrap 自身（或其依赖加载）抛错 → `createProdApp`/`createDevApp` reject → `listen()` 不执行、端口不暴露——与 `app:boot` 订阅端抛错同语义。
- **变更需重启**：订阅在 listen 前固定，不进热替换（与 `.env` 同款；dev watcher 仍会增量编译产物，无害）。

## 相关模块

- [appEventBus](../events/appEventBus.md)——事件目录、订阅语义、错误口径
- [createAppCore](./createAppCore.md)——`getApp()`、`app.on`、事件发射点
- [createProdApp](./createProdApp.md) / [createDevApp](./createDevApp.md)——内部启动 API（`loadBootstrap` 调用方）
