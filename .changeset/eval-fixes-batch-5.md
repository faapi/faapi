---
'@faapi/faapi': patch
---

框架评估修复批次 5：AST 静默弱化、插件加载口径、build 清目录与 CLI DX。

- **AST 三类静默弱化消除（不再违背「不降级放行」约定）**：
  - 接口/对象类型含方法签名或存取器此前被静默丢弃（校验弱于 TS 类型且无告警），现在显式抛 `SchemaExtractionError`
  - `Required<T>` 此前原样返回内部类型（可选字段在 schema 中仍是 optional），现在与 `Partial` 对称恢复必填；`Readonly<T>` 明确为编译期约束等同去掉修饰符
  - 交叉类型同名字段此前直接 push 合并（重复字段后者静默胜出，校验比 TS 宽松），现在按名去重（类型一致时保留带约束的声明），类型/可选性冲突（TS 语义为 never）显式抛错
- **loadPlugins 错误口径统一**：插件失败此前仅单条 `console.warn` 易被淹没（prod 下鉴权类插件静默丢失等同裸奔），现在收集进返回值 `failures` 并在加载完成后 `console.error` 汇总；非法声明不再崩启动；`path` 声明相对项目根目录解析为 file URL（此前相对 faapi 包产物解析，几乎必然失败）
- **build 清空输出目录（emptyOutDir 语义）**：删除/重命名路由后 `dist/` 不再残留死产物；防误删保护——outdir 不在 rootDir 内时跳过清空并告警
- **build 移除重复 `compileConfig` 调用**：mtime 缓存引入后第二次调用只命中缓存却打印 "Written to" 谎报日志
- **CLI**：`faapi --version` 输出版本号；命令失败输出一行友好摘要（`FAAPI_DEBUG=1` 附完整堆栈），不再裸堆栈糊屏
- **watcher**：重建失败逐条输出 esbuild 结构化错误（file:line + text），不再压扁成一句摘要；监听 `tsconfig.json` 变化（别名重写与 mtime 缓存输入）；增量编译跳过 `*.test.ts` / `*.e2e.test.ts` / `*.d.ts`（测试文件语法错误不再打断 dev 重建）
- **CORS**：动态 origin（true/数组）下 Origin 不匹配的拒绝响应同样补 `Vary: Origin`——缺了它 CDN 按 URL 缓存拒绝响应后可能服务给合法 Origin（缓存污染面）
