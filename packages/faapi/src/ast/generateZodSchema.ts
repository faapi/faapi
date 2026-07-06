import type { RuntimeType, TupleElement, PropertyType, TypeConstraint } from './resolveTypeNode';
import type { HandlerTypeInfo } from './extractHandlerTypes';

/**
 * 类型解析器：根据类型名获取 RuntimeType
 *
 * 用于解析循环引用中的 ref。调用方负责提供（通常从 AST 提取）。
 */
export type TypeResolver = (name: string) => RuntimeType | undefined;

/**
 * 代码生成上下文
 *
 * 跟踪已收集的命名类型，用于生成 z.lazy 声明。
 */
class CodeGenContext {
  /** 命名类型集合：name → RuntimeType */
  readonly namedTypes = new Map<string, RuntimeType>();
  /** 类型解析器（用于解析 ref 的实际类型） */
  readonly resolveType: TypeResolver;
  /** 入口类型原始名（typeInfo.name，用于识别入口类型的自引用） */
  entryTypeName = '';
  /** 入口类型导出名（exportName，自引用时用此名生成变量名） */
  entryExportName = '';
  /**
   * 是否生成 coerce 逻辑（query/params 场景，URL 来源均为 string）
   *
   * true 时为 number/boolean 字段包 z.preprocess，把合法的字符串转成对应类型。
   * 嵌套类型（array/object/tuple/union 等）的元素递归处理。
   */
  coerce = false;

  constructor(resolveType: TypeResolver) {
    this.resolveType = resolveType;
  }
}

/**
 * 从 RuntimeType 收集所有命名类型（ref）
 *
 * 递归遍历 RuntimeType，遇到 ref 时解析并加入 namedTypes。
 * 已收集的类型不重复处理（防止循环引用无限递归）。
 */
export function collectNamedTypes(type: RuntimeType, ctx: CodeGenContext): void {
  switch (type.kind) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'bigint':
    case 'null':
    case 'undefined':
    case 'any':
    case 'unknown':
    case 'literal':
    case 'date':
      return;

    case 'array':
      collectNamedTypes(type.element, ctx);
      return;

    case 'tuple':
      for (const el of type.elements) {
        collectNamedTypes(el.type, ctx);
      }
      return;

    case 'object':
      for (const prop of type.properties) {
        collectNamedTypes(prop.type, ctx);
      }
      return;

    case 'union':
      for (const member of type.members) {
        collectNamedTypes(member, ctx);
      }
      return;

    case 'record':
      collectNamedTypes(type.key, ctx);
      collectNamedTypes(type.value, ctx);
      return;

    case 'ref': {
      if (ctx.namedTypes.has(type.name)) return;
      // 先占位，防止循环引用无限递归
      ctx.namedTypes.set(type.name, { kind: 'any' });
      const resolved = ctx.resolveType(type.name);
      if (resolved) {
        ctx.namedTypes.set(type.name, resolved);
        collectNamedTypes(resolved, ctx);
      }
      return;
    }
  }
}

/**
 * RuntimeType → zod 表达式字符串（不含声明）
 *
 * @param type 类型描述
 * @param ctx 代码生成上下文
 * @param constraints 字段级约束（仅 object 字段传入，影响最外层 zod 链）
 */
export function runtimeTypeToZodExpression(
  type: RuntimeType,
  ctx: CodeGenContext,
  constraints?: TypeConstraint[],
): string {
  const expr = baseExpression(type, ctx);
  // 字段级约束链（@max/@min/@regex 等）追加到基础表达式后
  // coerce 模式下约束需作用在 preprocess 内部的 z.X() 上，故先应用约束再包裹 preprocess
  const withConstraints =
    constraints && constraints.length > 0 ? applyConstraints(expr, constraints, type.kind) : expr;
  // coerce 模式下，number/boolean 在外层包 z.preprocess
  // 嵌套类型（array/object/tuple/union 等）内部已递归处理，外层不再包裹
  if (ctx.coerce && (type.kind === 'number' || type.kind === 'boolean')) {
    return wrapCoercePreprocess(type.kind, withConstraints);
  }
  return withConstraints;
}

/**
 * 在 zod 表达式上追加约束链
 *
 * 约束与字段类型的匹配在 AST 提取阶段已校验，这里直接生成链式调用。
 *
 * coerce 模式下调用方应先 applyConstraints 再 wrapCoercePreprocess，
 * 使约束作用在 preprocess 内部的 z.X() 上，而非 preprocess 外壳。
 *
 * @param baseExpr 基础 zod 表达式（未包裹 preprocess）
 * @param constraints 约束数组
 * @param typeKind 字段类型 kind
 */
function applyConstraints(
  baseExpr: string,
  constraints: TypeConstraint[],
  typeKind: RuntimeType['kind'],
): string {
  const suffix = constraints.map((c) => constraintToZodChain(c, typeKind)).join('');
  return `${baseExpr}${suffix}`;
}

/**
 * 单个约束 → zod 链式方法字符串
 *
 * @param constraint 约束
 * @param typeKind 字段类型 kind（用于区分 string/array 的 max/min 含义）
 */
function constraintToZodChain(constraint: TypeConstraint, _typeKind: RuntimeType['kind']): string {
  switch (constraint.kind) {
    case 'max':
      return `.max(${constraint.value})`;
    case 'min':
      return `.min(${constraint.value})`;
    case 'int':
      return '.int()';
    case 'positive':
      return '.positive()';
    case 'negative':
      return '.negative()';
    case 'nonnegative':
      return '.nonnegative()';
    case 'nonpositive':
      return '.nonpositive()';
    case 'maxLength':
      return `.max(${constraint.value})`;
    case 'minLength':
      return `.min(${constraint.value})`;
    case 'length':
      return `.length(${constraint.value})`;
    case 'regex': {
      const flags = constraint.flags ?? '';
      // 用 new RegExp 构造，避免 pattern 中含 / 字符导致的字面量语法错误
      return `.regex(new RegExp(${JSON.stringify(constraint.pattern)}${flags ? `, ${JSON.stringify(flags)}` : ''}))`;
    }
    case 'email':
      return '.email()';
    case 'url':
      return '.url()';
    case 'uuid':
      return '.uuid()';
  }
}

/**
 * 生成基础 zod 表达式（不含 coerce 包裹）
 */
function baseExpression(type: RuntimeType, ctx: CodeGenContext): string {
  switch (type.kind) {
    case 'string':
      return 'z.string()';
    case 'number':
      return 'z.number()';
    case 'boolean':
      return 'z.boolean()';
    case 'bigint':
      // AST 提取阶段已抛错，这里不会到达
      return 'z.never()';
    case 'null':
      return 'z.null()';
    case 'undefined':
      return 'z.undefined()';
    case 'any':
    case 'unknown':
      return 'z.unknown()';
    case 'literal':
      return `z.literal(${JSON.stringify(type.value)})`;
    case 'array':
      return `z.array(${runtimeTypeToZodExpression(type.element, ctx)})`;
    case 'tuple':
      return generateTupleExpression(type.elements, ctx);
    case 'object':
      return generateObjectExpression(type.properties, ctx);
    case 'union':
      return generateUnionExpression(type.members, ctx);
    case 'date':
      // z.preprocess 限制只接受 string/Date：string → new Date(string)，其他原样传入
      // z.coerce.date() 会把 number 也转为 Date（new Date(123)），不符合需求
      // date 类型本身已用 preprocess，coerce 模式下无需再包一层
      return 'z.preprocess((v) => (typeof v === "string" ? new Date(v) : v), z.date())';
    case 'record':
      return `z.record(${runtimeTypeToZodExpression(type.key, ctx)}, ${runtimeTypeToZodExpression(type.value, ctx)})`;
    case 'ref':
      // ref 引用命名类型，直接用 NameSchema 变量
      // 入口类型的自引用需用 exportName（exportName 可能与 typeInfo.name 不同）
      if (type.name === ctx.entryTypeName) {
        return `${ctx.entryExportName}Schema`;
      }
      return `${type.name}Schema`;
  }
}

/**
 * coerceNumber 公用函数源码（ESM export 格式）
 *
 * 用于 query/params 的 string → number 转换：
 * - 合法数字字符串（"1"、"3.14"）转为 number
 * - 空串/NaN 保留原值，让 z.number() 报错（避免 Number("") = 0 的陷阱）
 *
 * 写入 outDir 根部的 faapi-helpers.js，各 zod.js 通过相对路径 import 复用。
 */
export const COERCE_NUMBER_HELPER =
  'export const coerceNumber = (v) => typeof v === "string" && v.trim() !== "" && !isNaN(Number(v)) ? Number(v) : v;';

/**
 * coerceBoolean 公用函数源码（ESM export 格式）
 *
 * 用于 query/params 的 string → boolean 转换：
 * - 'true'/'1' → true
 * - 'false'/'0' → false
 * - 其他值保留原值，让 z.boolean() 报错
 *
 * 写入 outDir 根部的 faapi-helpers.js，各 zod.js 通过相对路径 import 复用。
 */
export const COERCE_BOOLEAN_HELPER =
  'export const coerceBoolean = (v) => v === "true" || v === "1" ? true : v === "false" || v === "0" ? false : v;';

/**
 * faapi-helpers.js 文件名（生成在 outDir 根部）
 */
export const HELPERS_FILENAME = 'faapi-helpers.js';

/**
 * 生成 faapi-helpers.js 文件源码
 *
 * 包含 coerceNumber / coerceBoolean 两个公用函数（ESM export）。
 * 仅当项目中存在 coerce schema（query/params）时由 generateSchemaFiles 生成一次。
 */
export function generateHelpersFileSource(): string {
  return [
    '// faapi-helpers.js — faapi 自动生成的公用函数（请勿手动编辑）',
    COERCE_NUMBER_HELPER,
    COERCE_BOOLEAN_HELPER,
    '',
  ].join('\n');
}

/**
 * 检测代码是否引用了 coerceNumber / coerceBoolean 变量
 *
 * 用于 generateSchemaFiles 判断是否需要生成 faapi-helpers.js。
 */
export function usesCoerceHelpers(code: string): boolean {
  return code.includes('coerceNumber') || code.includes('coerceBoolean');
}

/**
 * 为 number/boolean 表达式包裹 z.preprocess（用于 query coerce）
 *
 * 引用从 faapi-helpers.js import 的 coerceNumber / coerceBoolean 变量，
 * 避免每个字段都内联一长串函数。
 */
function wrapCoercePreprocess(kind: 'number' | 'boolean', inner: string): string {
  if (kind === 'number') {
    return `z.preprocess(coerceNumber, ${inner})`;
  }
  return `z.preprocess(coerceBoolean, ${inner})`;
}

/**
 * 生成元组 zod 表达式
 *
 * zod 的 tuple 不直接支持可选元素，需要用 union 模拟：
 * - 全部必填：`z.tuple([e0, e1, ...])`
 * - 含可选元素：`z.union([z.tuple([e0]), z.tuple([e0, e1]), ...])`（从短到长）
 * - 含 rest：`z.tuple([e0, ...]).rest(eRest)`
 */
function generateTupleExpression(elements: TupleElement[], ctx: CodeGenContext): string {
  const fixedExprs: string[] = [];
  const fixedOptional: boolean[] = [];
  let restExpression = '';
  let restStarted = false;

  for (const el of elements) {
    if (el.rest) {
      restExpression = runtimeTypeToZodExpression(el.type, ctx);
      restStarted = true;
    } else if (!restStarted) {
      fixedExprs.push(runtimeTypeToZodExpression(el.type, ctx));
      fixedOptional.push(el.optional);
    }
  }

  // 含 rest 元素：z.tuple([fixed...]).rest(restType)
  if (restExpression) {
    return `z.tuple([${fixedExprs.join(', ')}]).rest(${restExpression})`;
  }

  // 无可选元素：z.tuple([e0, e1, ...])
  const hasOptional = fixedOptional.some((o) => o);
  if (!hasOptional) {
    return `z.tuple([${fixedExprs.join(', ')}])`;
  }

  // 含可选元素：从后往前截断可选元素，生成 union
  // TS 语法要求可选元素在必填元素之后，所以只需从后往前去掉可选元素
  const variants: string[] = [];
  for (let len = fixedExprs.length; len >= 0; len--) {
    // len === 0 时只有全部可选才有效（空元组）
    // len > 0 时，第 len-1 个元素必须存在（必填或可选都行）
    // 截断点：去掉 fixedExprs[len..end]，这些必须都是可选的
    const removed = fixedOptional.slice(len);
    if (removed.length > 0 && removed.some((o) => !o)) {
      // 被截断的元素中有必填元素，无效截断
      break;
    }
    const subset = fixedExprs.slice(0, len);
    variants.push(`z.tuple([${subset.join(', ')}])`);
  }

  // 从短到长排序（更自然的校验顺序）
  variants.reverse();
  if (variants.length === 1) {
    return variants[0]!;
  }
  return `z.union([${variants.join(', ')}])`;
}

/**
 * 生成对象 zod 表达式
 *
 * 可选字段用 .optional()，约束链在 .optional() 之前生成
 */
function generateObjectExpression(properties: PropertyType[], ctx: CodeGenContext): string {
  const fields = properties.map((prop) => {
    const expr = runtimeTypeToZodExpression(prop.type, ctx, prop.constraints);
    const finalExpr = prop.optional ? `${expr}.optional()` : expr;
    return `${JSON.stringify(prop.name)}: ${finalExpr}`;
  });
  return `z.object({ ${fields.join(', ')} })`;
}

/**
 * 生成联合类型 zod 表达式
 *
 * 优化：如果联合中包含 null，用 .nullable() 简化
 * 否则用 z.union([m0, m1, ...])
 */
function generateUnionExpression(members: RuntimeType[], ctx: CodeGenContext): string {
  const hasNull = members.some((m) => m.kind === 'null');
  const nonNull = members.filter((m) => m.kind !== 'null');

  // 只有一个非 null 成员 + null → .nullable()
  if (hasNull && nonNull.length === 1) {
    return `${runtimeTypeToZodExpression(nonNull[0]!, ctx)}.nullable()`;
  }

  // 多个成员 + null → z.union([...]).nullable()
  if (hasNull) {
    const unionInner = nonNull.map((m) => runtimeTypeToZodExpression(m, ctx)).join(', ');
    return `z.union([${unionInner}]).nullable()`;
  }

  // 无 null → z.union([...])
  const unionInner = members.map((m) => runtimeTypeToZodExpression(m, ctx)).join(', ');
  return `z.union([${unionInner}])`;
}

/**
 * 生成命名类型的 zod schema 声明
 *
 * - 无循环引用：`const NameSchema = z.object({ ... })`
 * - 有循环引用：`const NameSchema = z.lazy(() => z.object({ ... }))`
 */
function generateNamedTypeDeclaration(
  name: string,
  type: RuntimeType,
  ctx: CodeGenContext,
): string {
  const expr = runtimeTypeToZodExpression(type, ctx);
  const hasRef = containsRef(type, new Set([name]));
  if (hasRef) {
    // 循环引用：用 z.lazy 延迟求值
    return `const ${name}Schema = z.lazy(() => ${expr});`;
  }
  return `const ${name}Schema = ${expr};`;
}

/**
 * 检查 RuntimeType 是否包含对自身的 ref（循环引用）
 */
function containsRef(type: RuntimeType, visited: Set<string>): boolean {
  switch (type.kind) {
    case 'ref':
      return visited.has(type.name);
    case 'array':
      return containsRef(type.element, visited);
    case 'tuple':
      return type.elements.some((el) => containsRef(el.type, visited));
    case 'object':
      return type.properties.some((prop) => containsRef(prop.type, visited));
    case 'union':
      return type.members.some((m) => containsRef(m, visited));
    case 'record':
      return containsRef(type.key, visited) || containsRef(type.value, visited);
    default:
      return false;
  }
}

/**
 * 生成单个类型的 zod schema 代码（含命名类型声明）
 *
 * 返回的代码包含：
 * - `import { z } from 'zod'`
 * - 内部命名类型的 const 声明（带 z.lazy 循环引用保护）
 * - `export const NameSchema = ...` 入口导出
 *
 * @param typeInfo 类型信息
 * @param resolveType 类型解析器（用于解析 ref 的实际类型）
 * @param exportName 导出的 schema 变量名（不含 Schema 后缀）。默认用 typeInfo.name。
 *                   validateInput 按 `${schemaName}Schema` 查找，需与导出名一致。
 * @param coerce 是否生成 coerce 逻辑（query/params 场景）。默认 false。
 *               true 时为 number/boolean 字段（含嵌套元素）包 z.preprocess。
 */
export function generateZodSchemaSource(
  typeInfo: HandlerTypeInfo,
  resolveType: TypeResolver,
  exportName?: string,
  coerce = false,
): string {
  const ctx = new CodeGenContext(resolveType);
  const name = exportName ?? typeInfo.name;
  ctx.entryTypeName = typeInfo.name;
  ctx.entryExportName = name;
  ctx.coerce = coerce;

  // 收集入口类型中的所有命名类型（不含入口类型本身，避免重复声明）
  collectNamedTypes(typeInfo.runtimeType, ctx);
  ctx.namedTypes.delete(typeInfo.name);

  const lines: string[] = [];
  lines.push("import { z } from 'zod';");
  lines.push('');

  // 生成命名类型声明（z.lazy 处理循环引用）
  for (const [n, type] of ctx.namedTypes) {
    lines.push(generateNamedTypeDeclaration(n, type, ctx));
  }
  if (ctx.namedTypes.size > 0) lines.push('');

  // 生成入口 schema 导出（含循环引用时用 z.lazy）
  const entryExpr = runtimeTypeToZodExpression(typeInfo.runtimeType, ctx);
  const hasSelfRef = containsRef(typeInfo.runtimeType, new Set([typeInfo.name]));
  if (hasSelfRef) {
    lines.push(`export const ${name}Schema = z.lazy(() => ${entryExpr});`);
  } else {
    lines.push(`export const ${name}Schema = ${entryExpr};`);
  }

  return lines.join('\n');
}
