import ts from 'typescript';

/**
 * 判断节点是否有 `export` 修饰符
 */
export function hasExportModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const modifiers = ts.getModifiers(node);
  return !!modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

/**
 * 从节点提取第一个 JSDoc 注释块
 *
 * 1. 标准 API（`ts.getJSDocCommentsAndTags`，jsDocCache 已缓存时命中）
 * 2. 回退：直接访问解析器存入的 `node.jsDoc` 数组（jsDocCache 未同步的情况）
 */
export function getJSDocFromNode(node: ts.Node): ts.JSDoc | undefined {
  const apiDocs = ts
    .getJSDocCommentsAndTags(node)
    .filter((entry): entry is ts.JSDoc => ts.isJSDoc(entry));
  if (apiDocs.length > 0) return apiDocs[0];

  const directDocs = (node as unknown as { jsDoc?: ts.JSDoc[] }).jsDoc;
  if (directDocs && directDocs.length > 0) return directDocs[0];

  return undefined;
}

/**
 * 提取 JSDoc 描述（注释块自由文本，`@tag` 之前的首段）
 *
 * 多行描述保留换行（TypeScript 已自动剥离每行前缀 ` * `）。
 * 无 JSDoc / JSDoc 无自由文本 / 描述仅空白 / comment 为富文本结构 → `undefined`。
 */
export function extractDescription(jsDoc: ts.JSDoc | undefined): string | undefined {
  if (!jsDoc) return undefined;
  if (typeof jsDoc.comment !== 'string') return undefined;
  const trimmed = jsDoc.comment.trim();
  return trimmed || undefined;
}
