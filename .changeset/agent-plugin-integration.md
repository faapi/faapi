---
"@faapi/faapi": minor
"@faapi/agent": minor
---

Agent handle factory integration: @faapi/agent plugin now registers a factory that injects a real Agent instance into handler `agent` parameter.

- @faapi/faapi: export `registerAgentHandleFactory` / `clearAgentHandleFactory` / `AgentHandleFactory` from injection/agentHandle; export registry accessors (`getAgent`, `getTool`, `resolveAgentTools`, `resolveSubAgents`) and loaders (`loadAgentModule`, `loadToolModule`) for plugin consumption; `injectParams` `agent` parameter now calls `getAgentHandle(ctx)`; `createAppBase.close()` clears agent handle factory.
- @faapi/agent: add `AgentHandle` interface (Agent satisfies it structurally); add default export faapi plugin that reads `config.agent.llm` + `config.agent.defaultAgent`, creates LLM provider, and registers agent handle factory wiring real registry/loader accessors into `AgentDeps`.
