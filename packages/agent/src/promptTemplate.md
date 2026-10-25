# promptTemplate

一句话概括：agent 提示词模板渲染（内部模块,不进公开导出面）——把 `systemPrompt` / `systemPromptFile` 内容中的 `{{key}}` 占位符按 agent config 声明的 `vars`（静态字面量）渲染为最终 system 消息文本。

## 为什么需要

提示词文件（`systemPromptFile`）是静态字面量。「同一套提示词模板被多个 agent 复用、各自注入不同的静态特化内容」（同一审稿模板,情节审稿 agent 与文笔审稿 agent 填不同的审稿角色与关注点;同一协议模板按产品名/租户名特化）此前只能整份复制提示词文件——模板更新要改 N 处,复制件漂移无告警。

`{{key}}` 式双花括号占位符是提示词工程的事实语法（NovelForge 等提示词集）。vars 在 agent config 里静态声明（启动期求值进 `AgentCore.vars`,见主包 [loadAgents.md](../../faapi/src/agents/loadAgents.md)）,渲染在 base 解析之后、装饰钩子之前——提示词组装三层各司其职:**模板渲染**（占位符 → config 声明值,本模块）→ **装饰**（应用叠加协议块,`resolveSystemPrompt` 钩子）→ **traceId 块**（框架元数据,最后追加）。

## 使用场景

- **模板复用 + agent 特化**:多个 agent 的 `systemPromptFile` 指向同一个提示词文件,各自 config 声明不同的 `vars`（审稿角色、关注点、产品名等）,模板更新一处生效
- 提示词文件中需要展示字面 `{{...}}`（如教学模板语法）时用 `\{{...}}` 转义
- 动态内容（每次运行不同）不适用本机制——走 user input 字符串或 sub-agent 派发入参（per-agent `Input` schema）

## 语义细则

| 项 | 语义 |
| --- | --- |
| 声明来源 | agent config 的 `vars` 字段——启动期求值（平面对象,叶子 string/number/boolean）,声明与校验规则见主包 [loadAgents.md](../../faapi/src/agents/loadAgents.md) |
| 触发条件 | config 声明 `vars`（含空对象）→ 每次 run / sub-agent 派发渲染;未声明 → 完全不渲染——存量提示词中的 `{{...}}` 字面文本不受影响（逐字节现状） |
| 占位符语法 | `{{name}}` / `{{a.b.c}}` 点路径,容忍空白（`{{ name }}`）;段名为 `[A-Za-z_$][A-Za-z0-9_$]*`;vars 是平面对象,点路径中间段为对象时按缺失抛错 |
| 值渲染 | string 原样;number / boolean → `String()`（config 叶子无 null/undefined/对象——启动期校验已拦） |
| 缺失变量 | 显式抛错（含占位符名）,不静默留占位符;agent 层包装为 `AgentError`（带 agent 名,不发起 LLM 请求） |
| 非法占位符 | vars 已声明时,`{{...}}` 内容不匹配占位符语法（如 `{{}}` / `{{a b}}` / 中文名）→ 显式抛错;字面输出用 `\{{...}}` 转义 |
| 转义 | `\{{name}}` → 字面量 `{{name}}`（反斜杠被移除,不参与插值;渲染单遍扫描,渲染结果不再被二次扫描） |
| 原型属性 | 点路径逐段下钻只认自有属性（`Object.hasOwn`）——`{{constructor}}` / `{{__proto__}}` 等原型链键按缺失抛错 |
| 全链生效 | 顶层 `run` / `stream` 与 sub-agent 派发一致——vars 在 agent 元数据（meta）上,两条链路共享 `resolveSystemPrompt`,派发的子代理同样按其自身 config.vars 渲染 |
| 渲染时机 | `Agent.resolveSystemPrompt` 内 base（systemPromptFile 读文件 / 内联 systemPrompt）解析后、`deps.resolveSystemPrompt` 装饰钩子之前——钩子看到渲染后内容 |
| 新鲜度 | 每次 run / stream / 派发渲染,不缓存——与 systemPromptFile 每次读文件同款新鲜度,dev 改 prompt 文件立即生效;vars 值是注册时求值的静态平面对象（声明期固定,非构建期字面量） |

## 相关模块

- [agent](./agent.md) —— `resolveSystemPrompt` 调用本模块;vars 渲染时机与装饰钩子的关系见其「vars 提示词模板变量」章节
- faapi 核心 [loadAgents](../../faapi/src/agents/loadAgents.md) —— config.vars 的启动期求值与校验
- [agentErrors](./agentErrors.md) —— agent 层把渲染失败包装为 `AgentError`
