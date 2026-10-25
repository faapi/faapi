# jsDocMetadata

一句话概括：tool 元数据提取使用的 JSDoc 工具函数——export 修饰符判断、JSDoc 块提取、描述文本提取、`@<tag>` 标签值提取（现仅 `extractToolMetadata` 消费，用于检测已移除的 `@tool` 覆盖名标签）。

## 为什么需要

tool 元数据提取需要一组 JSDoc 解析原语（export 判断 / JSDoc 块 / 描述 / tag 值）。收口在独立模块后行为单一来源：JSDoc 解析行为调整（如 jsDocCache 回退策略）只改一处，调用方行为不会漂移。tag 提取现用于 `@tool` 残留标签的迁移检测（有值即迁移错误）；agent 侧的 `@agent` 检测随 agent 声明运行时化整体下线（运行时求值管线不做 JSDoc 提取）。

## 使用场景

- `extractToolMetadata`：从 handler.ts 提取 JSDoc 描述，并检测残留的 `@tool` 覆盖名标签（有值即迁移错误）
- 任何需要「导出函数 + JSDoc 注释 → 元数据」场景的新模块

## 行为定义

- `hasExportModifier(node)`：节点 modifiers 含 `ExportKeyword` 返回 true（`ts.canHaveModifiers` 防御）
- `getJSDocFromNode(node)`：先走标准 API `ts.getJSDocCommentsAndTags`（jsDocCache 已缓存时命中），回退直接访问解析器存入的 `node.jsDoc` 数组（cache 未同步场景）；返回第一个 JSDoc 或 undefined
- `extractDescription(jsDoc)`：`jsDoc.comment` 为 string 时返回 trim 结果（空串返回 undefined）；非 string（JSDocLink 等富文本）返回 undefined
- `extractJSDocTagValue(jsDoc, tagName)`：找第一个指定名 tag，comment 为非空 string 时返回去花括号后的文本（`@tool {name}` → `name`）；无 tag / 无 comment 文本（无值裸标签）返回 undefined（不构成残留，调用方不报错）

## 相关模块

- `extractToolMetadata.ts` - `@tool` 残留标签迁移检测（`extractJSDocTagValue(jsDoc, 'tool')`）——当前唯一消费方
