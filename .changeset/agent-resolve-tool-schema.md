---
"@faapi/faapi": minor
"@faapi/agent": minor
---

Tool input schema resolution: agents now dynamically load each tool's `zod.js` to validate LLM-provided arguments before invoking the tool handler.

- @faapi/faapi: add `loadToolSchema` (loader/loadToolSchema.ts) that dynamically imports a tool's `zod.js` and returns the schema object + schema name; export `loadToolSchema` and `ToolSchemaModule` from the public entry.
- @faapi/agent: implement `AgentDeps.resolveToolSchema` in the plugin — loads the tool schema via `loadToolSchema`, generates a JSON Schema with `z.toJSONSchema` for the LLM, and validates tool arguments via `schema.safeParse`; on validation failure returns `{ error }` (handler not called) so the react loop can feed the error back to the LLM for retry; missing `zod.js` falls back to free-form `{ type: 'object' }` schema.
