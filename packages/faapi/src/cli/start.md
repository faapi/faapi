# $start

一句话概括：唯一公开启动导出（`$` 前缀 = 框架内部标记）——完整启动 prod 应用，**仅供生成的 `dist/main.js` 使用**，业务不应直接调用。

## 为什么需要

零入口唯一化后 `createProdApp`/`createDevApp` 转为不公开导出的内部模块，但 `faapi build` 生成的 `dist/main.js` 住在用户项目里、`import` 解析到发布包公开面——需要一个仍然公开的符号承接生成物契约。`$start` 即该符号：命名用 `$` 前缀标记「框架内部协作面，业务不应直接调用」，与「面向业务的公开 API」区分。

## 使用场景

```js
// dist/main.js（faapi build 自动生成，请勿手动编辑）
import { loadEnv, $start } from '@faapi/faapi';

if (!process.env.NODE_ENV) process.env.NODE_ENV = 'production';
loadEnv(process.cwd());

await $start({ dist: '...' }); // 仅 --dist 非默认时写入参数
```

业务侧零入口：`faapi build` + `node dist/main` 即可；启动逻辑（事件订阅、初始化）写 `src/bootstrap.ts`（见 [bootstrap](./bootstrap.md)）。

## API

```ts
export interface StartOptions {
  /** 产物输出目录（默认 `dist`；`faapi build --dist` 非默认时由生成模板写入） */
  dist?: string;
}

export async function $start(options?: StartOptions): Promise<AppBase>;
```

内部流程：`createProdApp`（产物水合 + bootstrap 执行——bootstrap/订阅端抛错则 reject 且不 listen）→ `listen()`（`app:boot` → `server.listen` → `app:ready`）→ 返回 app（`getApp()` 此后可用）。

## 相关模块

- [createProdApp](./createProdApp.md)——内部模块，`$start` 委托其水合与 bootstrap 加载
- [bootstrap](./bootstrap.md)——`src/bootstrap.ts` 约定启动文件
- [createAppCore](./createAppCore.md)——`createAppBase` 编排核心与 `AppBase` 类型
- [appEventBus](../events/appEventBus.md)——事件目录与订阅口径
