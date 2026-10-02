# readResource

一句话概括：按相对路径读取当前 app 的产物 resources 目录内静态文件，路径越出 resources 即抛错（防穿越 / 防符号链接逃逸）；读取根在 app 启动时绑定，调用方免传。

## 为什么需要

业务方读资源若自己 `path.join` + `fs.readFile`，相对路径拼错（`../` 穿越、绝对路径误传）会静默读到 resources 外的任意文件；且不同上下文（HTTP/WS、任务、插件、lifecycle）各自持有 resourcesDir 字符串，读取入口散落。框架把读取收敛为一个免传参函数：调用方只给相对路径，读取根由框架绑定，越界一律显式失败。

## 使用场景

- HTTP/WS handler 读 prompt 模板、JSON 配置等：`import { readResource } from '@faapi/faapi'` + `readResource('prompts/greeting.md', 'utf-8')`
- 任务（进程内 / 隔离 worker）、插件 setup、lifecycle 钩子、编程式调用——同一函数同一形态
- `encoding` 省略时返回 Buffer（证书 / 字体等二进制资源），传 `BufferEncoding` 返回 string

## 约定与边界

- **免传参的前提是单 app**：faapi 单进程单 app（`createAppBase` 检测到存活 app 即抛错，多 app 同进程不支持），读取根经 `globalThis`（`Symbol.for('faapi.resources.dir')`）绑定且唯一。未绑定时调用抛 `[faapi] readResource: no active app` 清晰错误。
- **绑定点三处**：`createAppBase` 启动时绑定（插件 setup 前生效）、隔离任务 worker 由真实入口 `workerEntry.ts` 在任务模块求值前播种（入口自包含、值导入仅 node 内置模块，读取根经 globalThis 承载以跨入口/主包两份代码副本共享；symbol key 与本模块一致、契约测试锚定）、testing 直调经 `createTestContext` 的 `resourcesDir` 选项绑定。
- **安全边界是"不越出 resources 目录"**：`path.resolve` 后必须仍在 resources 内（拦绝对路径与 `..` 穿越），目标真实路径（realpath）也必须仍在 resources 内（拦符号链接指向目录外）；resources 内部的合法软链不误伤。目标不存在时不做符号链接检查，由 fs 抛自然 ENOENT。
- **越界与非法入参抛普通 `Error`（`[faapi]` 前缀）**，不是请求校验错误——路径来自业务代码而非客户端输入，传播出 handler 时按服务端错误落 500。
- **`resourcesDir` 各上下文数据字段保留**（FaapiContext / WsContext / TaskContext / PluginContext / AppBase / lifecycle 钩子参数）——供业务方了解 / 拼接资源位置，读取统一走本函数。

## 相关模块

- [copyResources](../cli/copyResources.md) — 资源复制管线（dev/build 把 `src/resources/` 镜像进产物），本函数读的是复制后的产物目录
- [prodPaths](./prodPaths.ts) — 复用 `isInsideDir`（目录包含判定）与 `toRealPath`（realpath 规范化，处理 macOS /tmp 符号链接差异）
- [appSingleton](../cli/appSingleton.md) — 同款 globalThis + Symbol.for 进程级状态机制；单 app 强制在 createAppBase 入口
- [createContext](../runtime/createContext.ts) — `createTestContext` 的 `resourcesDir` 选项 → 绑定全局读取根
- [taskWorker](../task/taskWorker.md) — 隔离 worker wrapper 内联播种读取根
