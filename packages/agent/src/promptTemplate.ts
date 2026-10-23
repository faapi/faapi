/**
 * agent run 级提示词模板渲染（内部模块,不进公开导出面）
 *
 * 把 systemPrompt / systemPromptFile 内容中的 `{{a.b.c}}` 点路径占位符按 vars 渲染。
 * 语义细则（占位符语法 / 值渲染 / 缺失抛错 / 转义 / 原型边界）见
 * [promptTemplate.md](./promptTemplate.md);调用方为 Agent.resolveSystemPrompt,
 * 渲染失败由其包装为 `AgentError`（带 agent 名,不发起 LLM 请求）。
 */

/** 占位符段名:标识符首字符 [A-Za-z_$],后续 [A-Za-z0-9_$],点分多层 */
const PLACEHOLDER_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/;

/** 依次匹配转义（`\{{...}}`）与占位符（`{{...}}`）;内容不含花括号——跨行/嵌套花括号文本不匹配 */
const TEMPLATE_SCAN = /\\\{\{[^{}]*\}\}|\{\{([^{}]*)\}\}/g;

/**
 * 渲染提示词模板:按 vars 填充 `{{a.b.c}}` 占位符
 *
 * - 占位符容忍空白（`{{ name }}`）;点路径逐段下钻,只认自有属性（原型链键按缺失）
 * - 值渲染:string 原样;number/boolean/bigint → `String()`;object/array → `JSON.stringify`
 * - 占位符无对应值（缺键 / 中间路径为 null / 值为 null·undefined）或语法非法 → 抛错,
 *   不静默留占位符;字面输出 `{{...}}` 用 `\{{...}}` 转义
 */
export function renderPromptTemplate(template: string, vars: Record<string, unknown>): string {
  return template.replace(TEMPLATE_SCAN, (match, inner?: string) => {
    if (inner === undefined) {
      // 转义分支:\{{...}} → 字面量 {{...}}（反斜杠被移除）
      return match.slice(1);
    }
    const name = inner.trim();
    if (!PLACEHOLDER_NAME.test(name)) {
      throw new Error(
        `[faapi] promptTemplate: 非法占位符 "${match}" — 占位符须为点分标识符（如 {{item.title}}）` +
          `;如需输出字面 {{...}} 请用 \\{{...}} 转义`,
      );
    }
    return renderValue(resolvePath(vars, name), name);
  });
}

/** 点路径逐段下钻;中间路径非对象（含数组外标量/函数）、非自有属性、末端 null/undefined 均按缺失抛错 */
function resolvePath(vars: Record<string, unknown>, name: string): unknown {
  let value: unknown = vars;
  for (const segment of name.split('.')) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, segment)) {
      throw new Error(missingMessage(name));
    }
    value = (value as Record<string, unknown>)[segment];
  }
  if (value === null || value === undefined) {
    throw new Error(missingMessage(name));
  }
  return value;
}

function renderValue(value: unknown, name: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  // symbol/function 无文本语义（JSON.stringify 会产出 undefined 字面量）——显式失败不静默
  if (typeof value === 'symbol' || typeof value === 'function') {
    throw new Error(
      `[faapi] promptTemplate: 模板变量 "{{${name}}}" 的值为 ${typeof value},不可渲染为文本`,
    );
  }
  return JSON.stringify(value);
}

function missingMessage(name: string): string {
  return `[faapi] promptTemplate: 模板变量 "{{${name}}}" 未提供 — vars 中缺少该键（或中间路径为 null/undefined/标量）`;
}
