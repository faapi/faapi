import type { HandlerTypeInfo } from './extractHandlerTypes';
import type { RuntimeType, PropertyType } from './resolveTypeNode';
import { SchemaExtractionError } from './resolveTypeNode';
import type { ValidationIssue } from '../errors/httpErrors';

/**
 * 将 RuntimeType 转为人类可读的类型描述字符串（用于 ValidationIssue.expected）
 *
 * 例如 'admin' | 'user' → "'admin' | 'user'"
 *      string | null → "string | null"
 *      Array<{ id: number }> → "object[]"
 */
function runtimeTypeToExpected(type: RuntimeType): string {
  switch (type.kind) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'null':
    case 'undefined':
    case 'bigint':
    case 'date':
    case 'any':
    case 'unknown':
      return type.kind;
    case 'literal':
      // 字符串字面量用单引号（符合 TS 习惯），数值/布尔直接输出
      return typeof type.value === 'string' ? `'${type.value}'` : String(type.value);
    case 'array':
      return `${runtimeTypeToExpected(type.element)}[]`;
    case 'tuple':
      return `[${type.elements
        .map((e) => (e.rest ? '...' : '') + runtimeTypeToExpected(e.type) + (e.optional ? '?' : ''))
        .join(', ')}]`;
    case 'object':
      return 'object';
    case 'union':
      return type.members.map(runtimeTypeToExpected).join(' | ');
    case 'record':
      return `Record<${runtimeTypeToExpected(type.key)}, ${runtimeTypeToExpected(type.value)}>`;
    case 'ref':
      return type.name;
  }
}

/**
 * 校验结果类型
 */
export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  data: Record<string, unknown>;
}

/**
 * schema 模块条目
 */
export interface SchemaModuleEntry {
  filePath: string;
  schemaName: string;
  typeInfo: HandlerTypeInfo | null;
}

/**
 * schema 模块导出格式
 */
export interface SchemaModuleExport {
  /** 校验函数表：'filePath#schemaName' -> ValidatorFn | null */
  validators: Record<string, ValidatorFn | null>;
  /** properties 表：'filePath#schemaName' -> PropertyType[]（用于 coerce） */
  properties: Record<string, PropertyType[]>;
}

/**
 * 校验函数类型
 */
export type ValidatorFn = (input: unknown) => ValidationResult;

/**
 * 类型解析器：根据类型名获取 RuntimeType
 *
 * 用于解析循环引用中的 ref。调用方负责提供（通常从 AST 提取）。
 */
export type TypeResolver = (name: string) => RuntimeType | undefined;

/**
 * 生成单个类型的校验函数源码
 *
 * 返回的源码包含：
 * - 内部命名类型的 validate_X 函数声明（带循环引用保护）
 * - 名为 `validate` 的入口函数
 *
 * 循环引用保护：每个 validate_X 函数用 WeakSet 追踪已访问对象，
 * 遇到已访问的对象直接跳过，防止无限递归。
 *
 * @param typeInfo 类型信息
 * @param resolveType 类型解析器（可选，用于解析循环引用中的 ref）
 *
 * 返回的源码包含 `validate(input)` 入口函数，可由调用方写入文件后 import，
 * 或用 `new Function('input', source + '; return validate(input);')` 执行。
 * 框架运行时统一走 `generateSchemaModule` 生成 JS 模块文件 → import 加载。
 */
export function generateValidatorSource(
  typeInfo: HandlerTypeInfo,
  resolveType?: TypeResolver,
): string {
  const ctx = new CodeGenContext(resolveType);
  // 收集所有命名类型（用于生成 validate_X 函数）
  collectNamedTypes(typeInfo.runtimeType, typeInfo.name, ctx);
  // 生成入口函数（每次调用重置所有 validate_X 的 __visited，防止跨调用残留）
  const resetVisited = Array.from(ctx.namedTypes.keys())
    .map((name) => `validate_${name}.__visited = new WeakSet();`)
    .join('\n  ');
  const entryBody = generateObjectValidation(typeInfo.runtimeType, 'input', 'issues', ctx, "''");
  const entryFn = `function validate(input) {
  const issues = [];
  ${resetVisited}
  ${entryBody}
  return { valid: issues.length === 0, issues, data: (typeof input === 'object' && input !== null && !Array.isArray(input)) ? input : {} };
}`;

  // 生成所有命名类型函数（带循环引用保护）
  const namedFns = Array.from(ctx.namedTypes.entries()).map(([name, type]) => {
    const body = generateObjectValidation(type, 'value', 'issues', ctx, 'path');
    return `function validate_${name}(value, path, issues) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    issues.push({ path, code: 'TYPE_MISMATCH', expected: 'object', received: typeof value, message: '期望对象' });
    return;
  }
  if (!validate_${name}.__visited) validate_${name}.__visited = new WeakSet();
  if (validate_${name}.__visited.has(value)) return;
  validate_${name}.__visited.add(value);
  ${body}
}`;
  });

  return [...namedFns, entryFn].join('\n\n');
}

/**
 * 生成完整 JS 模块源码
 *
 * 包含所有命名类型函数 + validators 导出对象
 *
 * @param entries schema 条目
 * @param resolveType 类型解析器（可选，用于解析循环引用中的 ref）
 */
export function generateSchemaModule(
  entries: SchemaModuleEntry[],
  resolveType?: TypeResolver,
): string {
  const ctx = new CodeGenContext(resolveType);
  const validatorEntries: string[] = [];
  const propertyEntries: string[] = [];

  // 先收集所有命名类型
  for (const entry of entries) {
    if (entry.typeInfo === null) continue;
    collectNamedTypes(entry.typeInfo.runtimeType, entry.typeInfo.name, ctx);
  }

  // 为每个 entry 生成重置 __visited 的代码
  const resetVisitedCode = Array.from(ctx.namedTypes.keys())
    .map((name) => `validate_${name}.__visited = new WeakSet();`)
    .join('\n    ');

  for (const entry of entries) {
    const key = `${entry.filePath}#${entry.schemaName}`;
    if (entry.typeInfo === null) {
      validatorEntries.push(`  ${JSON.stringify(key)}: null,`);
      continue;
    }
    const body = generateObjectValidation(entry.typeInfo.runtimeType, 'input', 'issues', ctx, "''");
    validatorEntries.push(`  ${JSON.stringify(key)}: (input) => {
    const issues = [];
    ${resetVisitedCode}
    ${body}
    return { valid: issues.length === 0, issues, data: (typeof input === 'object' && input !== null && !Array.isArray(input)) ? input : {} };
  },`);
    // 导出 properties（用于 coerce）
    propertyEntries.push(`  ${JSON.stringify(key)}: ${JSON.stringify(entry.typeInfo.properties)},`);
  }

  // 生成所有命名类型函数（去重，带循环引用保护）
  const namedFns = Array.from(ctx.namedTypes.entries()).map(([name, type]) => {
    const body = generateObjectValidation(type, 'value', 'issues', ctx, 'path');
    return `function validate_${name}(value, path, issues) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    issues.push({ path, code: 'TYPE_MISMATCH', expected: 'object', received: typeof value, message: '期望对象' });
    return;
  }
  if (!validate_${name}.__visited) validate_${name}.__visited = new WeakSet();
  if (validate_${name}.__visited.has(value)) return;
  validate_${name}.__visited.add(value);
  ${body}
}`;
  });

  return `${namedFns.join('\n\n')}

const validators = {
${validatorEntries.join('\n')}
};

const properties = {
${propertyEntries.join('\n')}
};

export { validators, properties };
`;
}

/**
 * 代码生成上下文
 */
class CodeGenContext {
  // collected 在 collectNamedTypes 等外部函数中访问，故不设为 private
  /** 命名类型集合：类型名 -> RuntimeType */
  namedTypes = new Map<string, RuntimeType>();
  /** 已收集的类型（防重复） */
  collected = new Set<string>();
  /** 类型解析器（用于解析 ref） */
  private resolveType?: TypeResolver;
  /** 变量名计数器（防止嵌套数组变量名遮蔽） */
  private varId = 0;

  constructor(resolveType?: TypeResolver) {
    this.resolveType = resolveType;
  }

  /** 生成唯一变量 ID */
  nextVarId(): number {
    return ++this.varId;
  }

  /**
   * 解析 ref：通过 resolveType 回调获取类型定义
   */
  resolveRef(name: string): RuntimeType | undefined {
    return this.resolveType?.(name);
  }
}

/**
 * 收集所有命名 object 类型
 *
 * 遇到 object 类型时注册为命名类型，递归收集属性中的命名类型。
 * 遇到 ref 时通过 resolveType 回调获取类型定义并收集。
 *
 * 同时检测必填直接循环引用（会导致无限递归，无法自然终止）：
 * - `next: LinkedList`（必填 ref）→ 抛错
 * - `next?: LinkedList`（可选 ref）→ 合法（undefined 可终止）
 * - `children: LinkedList[]`（数组 ref）→ 合法（空数组可终止）
 * - `next: LinkedList | null`（联合中的 ref）→ 合法（null 可终止）
 */
function collectNamedTypes(type: RuntimeType, name: string, ctx: CodeGenContext): void {
  if (ctx.collected.has(name)) return;
  ctx.collected.add(name);

  if (type.kind === 'object') {
    ctx.namedTypes.set(name, type);
    for (const prop of type.properties) {
      detectRequiredRef(prop, name);
      collectNamedTypesFromType(prop.type, ctx);
    }
  }
}

/**
 * 检测必填直接循环引用并抛错
 *
 * 只检测 `!optional && type.kind === 'ref'`。
 * 数组元素、联合成员中的 ref 不检测（它们有自然终止条件）。
 */
function detectRequiredRef(prop: PropertyType, ownerName: string): void {
  if (!prop.optional && prop.type.kind === 'ref') {
    throw new SchemaExtractionError(
      ownerName,
      `属性 "${prop.name}" 是必填的循环引用（类型 ${prop.type.name}），会导致无限递归。请改为可选（${prop.name}?: ${prop.type.name}）或数组（${prop.name}: ${prop.type.name}[]）。`,
    );
  }
}

/**
 * 从任意类型中收集命名类型
 */
function collectNamedTypesFromType(type: RuntimeType, ctx: CodeGenContext): void {
  switch (type.kind) {
    case 'array':
      collectNamedTypesFromType(type.element, ctx);
      break;
    case 'tuple':
      for (const elem of type.elements) {
        collectNamedTypesFromType(elem.type, ctx);
      }
      break;
    case 'union':
      for (const member of type.members) {
        collectNamedTypesFromType(member, ctx);
      }
      break;
    case 'object':
      // 匿名 object，不需要生成 validate_X，但仍需检测必填 ref
      for (const prop of type.properties) {
        detectRequiredRef(prop, '<匿名对象>');
        collectNamedTypesFromType(prop.type, ctx);
      }
      break;
    case 'record':
      collectNamedTypesFromType(type.value, ctx);
      break;
    case 'ref': {
      // 命名类型引用：通过 resolveType 获取定义并收集
      if (!ctx.collected.has(type.name)) {
        const resolved = ctx.resolveRef(type.name);
        if (resolved) {
          collectNamedTypes(resolved, type.name, ctx);
        }
      }
      break;
    }
  }
}

/**
 * 生成对象类型的校验代码
 *
 * @param pathExpr 当前路径表达式（入口为 "''"，命名类型函数体为 "path"）
 */
function generateObjectValidation(
  type: RuntimeType,
  varName: string,
  issuesVar: string,
  ctx: CodeGenContext,
  pathExpr: string,
): string {
  if (type.kind !== 'object') {
    return generateValueValidation(type, varName, issuesVar, ctx, pathExpr);
  }

  const lines: string[] = [];
  for (const prop of type.properties) {
    // 入口路径为空字符串时，子属性路径直接用字面量；否则用 pathExpr 拼接
    const propPath = pathExpr === "''" ? `'${prop.name}'` : `${pathExpr} + '.${prop.name}'`;
    const propAccess = `${varName}['${prop.name}']`;
    const hasCheck = `'${prop.name}' in ${varName}`;

    if (!prop.optional) {
      lines.push(
        `if (!${hasCheck}) ${issuesVar}.push({ path: ${propPath}, code: 'MISSING_FIELD', expected: '${prop.name}', received: 'undefined', message: '缺少必填字段 "${prop.name}"' });`,
      );
      lines.push(`else {`);
    } else {
      lines.push(`if (${hasCheck} && ${propAccess} !== undefined) {`);
    }

    lines.push(`  ${generateValueValidation(prop.type, propAccess, issuesVar, ctx, propPath)}`);

    lines.push(`}`);
  }
  return lines.join('\n');
}

/**
 * 生成值类型的校验代码
 */
function generateValueValidation(
  type: RuntimeType,
  varName: string,
  issuesVar: string,
  ctx: CodeGenContext,
  pathExpr?: string,
): string {
  const path = pathExpr ?? "''";

  switch (type.kind) {
    case 'any':
    case 'unknown':
      return ''; // 不校验

    case 'string':
      return `if (typeof ${varName} !== 'string') ${issuesVar}.push({ path: ${path}, code: 'TYPE_MISMATCH', expected: 'string', received: typeof ${varName}, message: '期望 string，实际 ' + typeof ${varName} });`;

    case 'number':
      return `if (typeof ${varName} !== 'number' || Number.isNaN(${varName})) ${issuesVar}.push({ path: ${path}, code: 'TYPE_MISMATCH', expected: 'number', received: typeof ${varName}, message: '期望 number，实际 ' + typeof ${varName} });`;

    case 'boolean':
      return `if (typeof ${varName} !== 'boolean') ${issuesVar}.push({ path: ${path}, code: 'TYPE_MISMATCH', expected: 'boolean', received: typeof ${varName}, message: '期望 boolean，实际 ' + typeof ${varName} });`;

    case 'bigint':
      // HTTP 不能传输 BigInt,声明 bigint 的字段必然校验失败
      return `if (typeof ${varName} !== 'bigint') ${issuesVar}.push({ path: ${path}, code: 'TYPE_MISMATCH', expected: 'bigint', received: typeof ${varName}, message: '期望 bigint，实际 ' + typeof ${varName} });`;

    case 'null':
      return `if (${varName} !== null) ${issuesVar}.push({ path: ${path}, code: 'TYPE_MISMATCH', expected: 'null', received: typeof ${varName}, message: '期望 null，实际 ' + typeof ${varName} });`;

    case 'undefined':
      return `if (${varName} !== undefined) ${issuesVar}.push({ path: ${path}, code: 'TYPE_MISMATCH', expected: 'undefined', received: typeof ${varName}, message: '期望 undefined' });`;

    case 'literal':
      return `if (${varName} !== ${JSON.stringify(type.value)}) ${issuesVar}.push({ path: ${path}, code: 'INVALID_VALUE', expected: ${JSON.stringify(JSON.stringify(type.value))}, received: JSON.stringify(${varName}), message: '期望字面量 ${JSON.stringify(type.value)}，实际 ' + JSON.stringify(${varName}) });`;

    case 'date':
      // HTTP 传输的是 ISO 字符串,允许 Date 实例或合法 ISO 8601 字符串
      // 类型不符 -> TYPE_MISMATCH; 类型对但格式非法 -> INVALID_FORMAT
      return `if (${varName} instanceof Date) { /* Date 实例,通过 */ }
else if (typeof ${varName} !== 'string') ${issuesVar}.push({ path: ${path}, code: 'TYPE_MISMATCH', expected: 'Date | ISO 8601 string', received: typeof ${varName}, message: '期望 Date 或 ISO 8601 字符串，实际 ' + typeof ${varName} });
else if (!/^\\d{4}-\\d{2}-\\d{2}(T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,3})?(Z|[+-]\\d{2}:?\\d{2})?)?$/.test(${varName}) || isNaN(new Date(${varName}).getTime())) ${issuesVar}.push({ path: ${path}, code: 'INVALID_FORMAT', expected: 'ISO 8601', received: String(${varName}), message: '不是合法的 ISO 8601 日期字符串: ' + ${varName} });`;

    case 'array': {
      const id = ctx.nextVarId();
      const itemVar = `item${id}`;
      const indexVar = `i${id}`;
      const elemPath = `${path} + '[' + ${indexVar} + ']'`;
      const elemValidation = generateValueValidation(
        type.element,
        itemVar,
        issuesVar,
        ctx,
        elemPath,
      );
      return `if (!Array.isArray(${varName})) ${issuesVar}.push({ path: ${path}, code: 'TYPE_MISMATCH', expected: 'array', received: typeof ${varName}, message: '期望数组，实际 ' + typeof ${varName} });
else for (let ${indexVar} = 0; ${indexVar} < ${varName}.length; ${indexVar}++) { const ${itemVar} = ${varName}[${indexVar}]; ${elemValidation} }`;
    }

    case 'tuple': {
      // 元组：按位置校验,支持可选元素和剩余元素
      // - 必填元素：缺失报 MISSING_FIELD
      // - 可选元素：缺失不报错
      // - 剩余元素：之后的元素都按 rest 类型校验
      const minRequired = type.elements.filter((e) => !e.optional && !e.rest).length;
      const fixedCount = type.elements.filter((e) => !e.rest).length;
      const restElement = type.elements.find((e) => e.rest);
      const id = ctx.nextVarId();
      const itemVar = `t${id}`;
      const indexVar = `ti${id}`;

      // 数组类型检查 + 长度检查
      const lines: string[] = [];
      lines.push(
        `if (!Array.isArray(${varName})) ${issuesVar}.push({ path: ${path}, code: 'TYPE_MISMATCH', expected: 'tuple', received: typeof ${varName}, message: '期望元组（数组），实际 ' + typeof ${varName} });`,
      );
      lines.push(`else {`);
      // 最小长度检查（必填元素数量）
      lines.push(
        `if (${varName}.length < ${minRequired}) ${issuesVar}.push({ path: ${path}, code: 'MISSING_FIELD', expected: 'tuple length >= ${minRequired}', received: 'length ' + ${varName}.length, message: '元组长度不足，期望至少 ${minRequired}，实际 ' + ${varName}.length });`,
      );
      // 最大长度检查（无 rest 时不能超过固定元素数量）
      if (!restElement) {
        lines.push(
          `if (${varName}.length > ${fixedCount}) ${issuesVar}.push({ path: ${path}, code: 'INVALID_VALUE', expected: 'tuple length = ${fixedCount}', received: 'length ' + ${varName}.length, message: '元组长度超出，期望 ${fixedCount}，实际 ' + ${varName}.length });`,
        );
      }

      // 按位置校验固定元素
      for (let i = 0; i < type.elements.length; i++) {
        const elem = type.elements[i];
        if (elem.rest) continue; // rest 元素单独处理
        const elemPath = `${path} + '[' + ${i} + ']'`;
        const elemAccess = `${varName}[${i}]`;
        if (elem.optional) {
          lines.push(`if (${i} < ${varName}.length && ${elemAccess} !== undefined) {`);
        } else {
          lines.push(`if (${i} < ${varName}.length) {`);
        }
        lines.push(`  ${generateValueValidation(elem.type, elemAccess, issuesVar, ctx, elemPath)}`);
        lines.push(`}`);
      }

      // 剩余元素校验
      if (restElement) {
        const restPath = `${path} + '[' + ${indexVar} + ']'`;
        const restValidation = generateValueValidation(
          restElement.type,
          itemVar,
          issuesVar,
          ctx,
          restPath,
        );
        lines.push(
          `for (let ${indexVar} = ${fixedCount}; ${indexVar} < ${varName}.length; ${indexVar}++) { const ${itemVar} = ${varName}[${indexVar}]; ${restValidation} }`,
        );
      }

      lines.push(`}`);
      return lines.join('\n');
    }

    case 'union': {
      // 联合类型：生成临时 issues 数组，任一成员匹配即可
      const tempVar = `tempIssues_${Math.random().toString(36).slice(2, 8)}`;
      const memberChecks = type.members.map((member) => {
        const check = generateValueValidation(member, varName, tempVar, ctx, path);
        return `(() => { const ${tempVar} = []; ${check}; return ${tempVar}.length === 0; })()`;
      });
      const expected = runtimeTypeToExpected(type);
      return `if (!(${memberChecks.join(' || ')})) ${issuesVar}.push({ path: ${path}, code: 'TYPE_MISMATCH', expected: ${JSON.stringify(expected)}, received: typeof ${varName}, message: '值 ' + JSON.stringify(${varName}) + ' 不匹配联合类型 ${expected.replace(/'/g, "\\'")}' });`;
    }

    case 'record': {
      const valuePath = `${path} + '.' + key`;
      const valueValidation = generateValueValidation(type.value, 'val', issuesVar, ctx, valuePath);
      return `if (typeof ${varName} !== 'object' || ${varName} === null || Array.isArray(${varName})) ${issuesVar}.push({ path: ${path}, code: 'TYPE_MISMATCH', expected: 'object', received: typeof ${varName}, message: '期望对象，实际 ' + typeof ${varName} });
else for (const [key, val] of Object.entries(${varName})) { ${valueValidation} }`;
    }

    case 'object': {
      // 匿名 object：内联校验
      return generateInlineObjectValidation(type, varName, issuesVar, ctx, path);
    }

    case 'ref': {
      // 命名类型引用：调用 validate_X 函数（支持循环引用递归）
      return `validate_${type.name}(${varName}, ${path}, ${issuesVar});`;
    }
  }
}

/**
 * 生成内联对象校验代码（匿名 object）
 */
function generateInlineObjectValidation(
  type: RuntimeType & { kind: 'object' },
  varName: string,
  issuesVar: string,
  ctx: CodeGenContext,
  pathExpr: string,
): string {
  const lines: string[] = [];
  lines.push(
    `if (typeof ${varName} !== 'object' || ${varName} === null || Array.isArray(${varName})) ${issuesVar}.push({ path: ${pathExpr}, code: 'TYPE_MISMATCH', expected: 'object', received: typeof ${varName}, message: '期望对象，实际 ' + typeof ${varName} });`,
  );
  lines.push('else {');
  for (const prop of type.properties) {
    const propPath = `${pathExpr} + '.${prop.name}'`;
    const propAccess = `${varName}['${prop.name}']`;
    const hasCheck = `'${prop.name}' in ${varName}`;

    if (!prop.optional) {
      lines.push(
        `  if (!${hasCheck}) ${issuesVar}.push({ path: ${propPath}, code: 'MISSING_FIELD', expected: '${prop.name}', received: 'undefined', message: '缺少必填字段 "${prop.name}"' });`,
      );
      lines.push(`  else {`);
    } else {
      lines.push(`  if (${hasCheck} && ${propAccess} !== undefined) {`);
    }
    lines.push(`    ${generateValueValidation(prop.type, propAccess, issuesVar, ctx, propPath)}`);
    lines.push(`  }`);
  }
  lines.push('}');
  return lines.join('\n');
}
