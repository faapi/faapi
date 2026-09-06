---
'@faapi/faapi': minor
---

新增 listen 前生命周期钩子 `lifecycle.onBoot`；本地 TS 插件（`{ path: './plugins/xxx' }`）dev 按需编译、build 预编译后可正常加载。

**`lifecycle.onBoot`（listen 前钩子）**：在 `server.listen` 调用之前执行（server 已创建但未监听，路由/tool/agent 清单已水合、插件已加载），适合启动校验（环境变量、下游依赖）、DB 迁移等"失败即不该暴露端口"的逻辑。钩子抛错 → `listen()` 以原始错误 reject，`server.listen` 不会被调用，端口不暴露。与 `onReady` 的差异：onReady 在 listen 回调内执行，失败时端口已开，存在"接受连接但不服务"的窗口——启动校验放 onBoot，资源初始化放 onReady。

```ts
export default {
  lifecycle: {
    async onBoot({ rootDir, routes }) {
      if (!process.env.DB_HOST) throw new Error('DB_HOST is required');
    },
    async onReady() {
      await initDb();
    },
  },
} satisfies FaapiConfig;
```

**本地 TS 插件可加载**：此前 `{ path: './plugins/xxx' }` 指向 `.ts` 文件时无论 dev/prod 均加载失败（Node ESM 对 file URL 不做扩展名补全，无扩展名声明直接 `Cannot find module`），且失败易被忽视。现在：

- 加载前探测源文件（`xxx.ts` → `xxx.js` → `xxx/index.ts` → `xxx/index.js`）
- dev：`.ts` 插件按需编译到 `.faapi/plugins/` 后加载，插件内部 `import '../src/xxx'`（无扩展名）可用；src 内插件走打平产物，与 routes 共享同一运行时对象
- prod：`faapi build` 把 `.ts` 插件编译到 `dist/plugins/`（构建日志 `[2.5/8] Compiling local plugins`），`node dist/main` 直接加载产物；产物 stale 时启动报错指引 `faapi build`，不静默使用旧产物
- 探测失败时报错带候选文件清单与修复指引，失败明细继续进 `failures` 汇总输出

配套修正 `aliasPlugin` 的 src 前缀剥离：剥离后的 import 路径改为相对 importer 产物位置计算——config 产物（dist 根）行为不变，src 外子目录模块（如插件）引用 src 内模块时正确回退 `../`。
