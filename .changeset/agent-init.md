---
"@faapi/agent": major
---

初始化 `@faapi/agent` 子包——faapi 的 agent 运行时。

在 faapi 核心包已扫描的 `faapi-agents.js` + `faapi-tools.js` 清单之上提供 LLM 驱动的 ReAct 循环、tool calling、sub-agent 递归与流式输出。

Phase 3.1：包骨架初始化（按 [AGENTS.md 6.5](../../AGENTS.md) 清单配置 package.json / tsconfig / tsup / vitest / LICENSE / README）。后续阶段将依次实现 LLM Provider 接口、reactLoop 循环引擎、Agent 类与 faapi 核心集成。
