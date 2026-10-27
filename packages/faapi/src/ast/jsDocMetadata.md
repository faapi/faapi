# jsDocMetadata

一句话概括：tool 元数据提取使用的 JSDoc 工具函数——export 修饰符判断、JSDoc 块提取、描述文本提取。

## 为什么需要

tool 元数据提取需要一组 JSDoc 解析原语（export 判断 / JSDoc 块 / 描述）。收口在独立模块后行为单一来源：JSDoc 解析行为调整（如 jsDocCache 回退策略）只改一处，调用方行为不会漂移。agent 侧不做 JSDoc 提取（声明由运行时求值管线装载）。

## 使用场景

- `extractToolMetadata`：从 handler.ts 提取 JSDoc 描述
- 任何需要「导出函数 + JSDoc 注释 → 元数据」场景的新模块

## 行为定义

- `hasExportModifier(node)`：节点 modifiers 含 `ExportKeyword` 返回 true（`ts.canHaveModifiers` 防御）
- `getJSDocFromNode(node)`：先走标准 API `ts.getJSDocCommentsAndTags`（jsDocCache 已缓存时命中），回退直接访问解析器存入的 `node.jsDoc` 数组（cache 未同步场景）；返回第一个 JSDoc 或 undefined
- `extractDescription(jsDoc)`：`jsDoc.comment` 为 string 时返回 trim 结果（空串返回 undefined）；非 string（JSDocLink 等富文本）返回 undefined

## 相关模块

- `extractToolMetadata.ts` - 当前唯一消费方（`extractDescription` / `getJSDocFromNode`）
