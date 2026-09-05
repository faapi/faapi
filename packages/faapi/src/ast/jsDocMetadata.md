# jsDocMetadata

一句话概括：tool/agent 元数据提取共用的 JSDoc 工具函数——export 修饰符判断、JSDoc 块提取、描述文本提取、`@<tag>` 覆盖名提取。

## 为什么需要

`extractToolMetadata` 与 `extractAgentMetadata` 此前各自维护一份逐字相同的 `hasExportModifier` / `getJSDocFromNode` / `extractDescription`，tag 提取（`@tool` / `@agent`）也是仅 tagName 一个词之差的同构实现。JSDoc 解析行为调整（如 jsDocCache 回退策略）必须双处同步，漏改即 tool 与 agent 的描述提取行为不一致。

## 使用场景

- `extractToolMetadata` / `extractAgentMetadata`：从 handler.ts 提取 JSDoc 描述与覆盖名
- 任何需要「导出函数 + JSDoc 注释 → 元数据」场景的新模块

## 行为定义

- `hasExportModifier(node)`：节点 modifiers 含 `ExportKeyword` 返回 true（`ts.canHaveModifiers` 防御）
- `getJSDocFromNode(node)`：先走标准 API `ts.getJSDocCommentsAndTags`（jsDocCache 已缓存时命中），回退直接访问解析器存入的 `node.jsDoc` 数组（cache 未同步场景）；返回第一个 JSDoc 或 undefined
- `extractDescription(jsDoc)`：`jsDoc.comment` 为 string 时返回 trim 结果（空串返回 undefined）；非 string（JSDocLink 等富文本）返回 undefined
- `extractJSDocTagValue(jsDoc, tagName)`：找第一个指定名 tag，comment 为非空 string 时返回去花括号后的文本（`@tool {name}` → `name`）；无 tag / 无 comment 文本返回 undefined（调用方回退到路径推导值，不报错）

## 相关模块

- `extractToolMetadata.ts` - `@tool` 覆盖名提取（`extractJSDocTagValue(jsDoc, 'tool')`）
- `extractAgentMetadata.ts` - `@agent` 覆盖名提取（`extractJSDocTagValue(jsDoc, 'agent')`）
