---
"@faapi/agent": minor
---

Add multi-agent demo fixtures + e2e test: validates the full pipeline from fixture compilation (routes + agents + tools + config artifacts) through `createProdApp` registry hydration to `agent.run()` executing weather tool calls and writer sub-agent recursion via `app.inject()`.
