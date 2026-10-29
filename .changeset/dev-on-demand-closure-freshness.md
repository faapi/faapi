---
'@faapi/faapi': patch
---

fix(faapi): dev 按需编译产物新鲜度改为依赖闭包感知，消除停机期间重构导致的新旧产物混编

dev server 停机期间源码被改（本机重构 / git pull）后重启，入口（bootstrap / handler / 中间件 / tool / agent / task）自身产物 mtime 仍新鲜时，此前会跳过依赖闭包检查——旧入口产物继续 import 陈旧依赖产物，与启动期 `compileConfig` 重编译的 config 闭包产物新旧混编：依赖导出面变更时报 `does not provide an export named ...`（报错点距根因很远），仅内部实现变更则静默跑旧代码。现在 `ensureCompiled` 对入口与依赖闭包逐文件做 mtime 新鲜度检查，发现 stale 只补编译 stale 集，全 fresh 零编译跳过（闭包扫描仅在每入口每进程首次调用发生）。`ensureSchemaGenerated` 同步收紧——zod.js 内容内联跨文件类型，新鲜度要求 zod.js 不晚于闭包内任何源文件，依赖类型在停机期间被改后重新生成。
