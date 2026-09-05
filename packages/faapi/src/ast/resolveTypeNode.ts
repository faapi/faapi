import ts from 'typescript';

/**
 * 模块级 Program 上下文,供 `resolveImportAlias` 兜底遍历跨文件声明使用
 *
 * TypeScript 的 `TypeChecker` 类型声明了 `getProgram(): Program` 方法,但
 * 运行时实例未暴露该方法(实测 `typeof checker.getProgram === 'undefined'`)。
 * 因此采用模块级变量在调用入口设置当前 program,resolveImportAlias 兜底时读取。
 *
 * 调用入口(`extractTypeInfo` / `extractAllTypes`)在分析前调
 * `setProgramContext(program)`,分析结束后调 `setProgramContext(null)` 清空。
 *
 * 串行场景安全:faapi 的 AST 提取在单线程顺序执行,无并发。
 */
let currentProgram: ts.Program | null = null;

/**
 * 设置当前 Program 上下文(供 resolveImportAlias 兜底遍历跨文件声明使用)
 *
 * @param program 当前 program;分析结束后传 null 清空
 */
export function setProgramContext(program: ts.Program | null): void {
  currentProgram = program;
}

/**
 * Schema 提取错误
 *
 * 遇到无法解析或不支持运行时校验的类型时抛出，
 * 避免静默降级为 any 导致用户不知情。
 */
export class SchemaExtractionError extends Error {
  constructor(
    public readonly typeText: string,
    public readonly reason: string,
    options?: ErrorOptions,
  ) {
    super(`无法解析类型 "${typeText}": ${reason}`, options);
    this.name = 'SchemaExtractionError';
  }
}

/**
 * 运行时类型描述
 *
 * 用于校验器在运行时判断值的结构是否符合声明类型。
 * 相比单纯的字符串，能描述数组元素类型、嵌套对象、联合类型等。
 */
export type RuntimeType =
  | { kind: 'string' }
  | { kind: 'number' }
  | { kind: 'boolean' }
  | { kind: 'bigint' }
  | { kind: 'null' }
  | { kind: 'undefined' }
  | { kind: 'any' } // 不校验
  | { kind: 'unknown' } // 不校验
  | { kind: 'literal'; value: string | number | boolean } // 字面量
  | { kind: 'array'; element: RuntimeType }
  | { kind: 'tuple'; elements: TupleElement[] }
  | { kind: 'object'; properties: PropertyType[]; catchall?: RuntimeType }
  | { kind: 'union'; members: RuntimeType[] }
  | { kind: 'date' }
  | { kind: 'record'; key: RuntimeType; value: RuntimeType }
  | { kind: 'map'; key: RuntimeType; value: RuntimeType } // Map<K,V>，JSON 序列化为 entries 数组
  | { kind: 'set'; element: RuntimeType } // Set<T>，JSON 序列化为数组
  | { kind: 'ref'; name: string }; // 命名类型引用（支持循环引用）

/**
 * 元组元素类型
 *
 * - optional: 该位置元素可省略（如 `[string, number?]`）
 * - rest: 该位置是剩余元素（如 `[string, ...number[]]`），必须是数组类型,展开后逐个校验
 */
export interface TupleElement {
  type: RuntimeType;
  optional: boolean;
  rest: boolean;
}

export interface PropertyType {
  name: string;
  type: RuntimeType;
  optional: boolean;
  /**
   * 字段级 JSDoc 约束标签（@max/@min/@maxLength 等）
   *
   * 来自字段 JSDoc 注释，由 generateZodSchema 转为 zod 链式调用。
   * 约束与字段类型不匹配时在提取阶段抛 SchemaExtractionError。
   */
  constraints?: TypeConstraint[];
}

/**
 * JSDoc 约束标签的运行时描述
 *
 * 由字段 JSDoc 注释提取，对应 zod schema 的链式约束方法。
 * 仅在 PropertyType.constraints 中出现，不挂在嵌套类型（array 元素、tuple 元素等）上。
 */
export type TypeConstraint =
  // 数值约束（仅 number 字段）
  | { kind: 'max'; value: number }
  | { kind: 'min'; value: number }
  | { kind: 'int' }
  | { kind: 'positive' }
  | { kind: 'negative' }
  | { kind: 'nonnegative' }
  | { kind: 'nonpositive' }
  // 长度约束（string 或 array 字段）
  | { kind: 'maxLength'; value: number }
  | { kind: 'minLength'; value: number }
  | { kind: 'length'; value: number }
  // 字符串格式约束（仅 string 字段）
  | { kind: 'regex'; pattern: string; flags?: string }
  | { kind: 'email' }
  | { kind: 'url' }
  | { kind: 'uuid' };

/**
 * 将 TypeScript 类型节点解析为运行时类型描述
 *
 * 支持的类型：
 * - 基础类型：string / number / boolean / null / undefined / any / unknown / void
 * - bigint：不支持（HTTP/JSON 不能传输），AST 提取阶段抛 SchemaExtractionError
 * - 字面量类型：'foo' / 42 / true
 * - 数组类型：T[] / Array<T> / ReadonlyArray<T> / readonly T[]
 * - 元组类型：[string, number] / [string, number?] / [string, ...number[]] / readonly [T, U]（按位置校验）
 * - 对象类型：{ name: string; age?: number }（含 readonly 字段修饰符，忽略 readonly）
 * - 联合类型：string | null
 * - 交叉类型：A & B（按对象合并处理）
 * - 引用类型：Date / 其他 interface（递归解析）
 * - 工具类型：Record<K, V> / Partial<T> / Readonly<T>（best effort）
 * - Pick<T, K> / Omit<T, K>：K 支持字面量联合、类型别名、keyof T
 *
 * readonly 是编译期约束，运行时不产生校验语义，所有 readonly 修饰符统一忽略。
 *
 * @param typeNode TypeScript 类型节点
 * @param checker  类型 checker（用于解析引用类型）
 * @param visited  防止递归循环
 * @param bindings 泛型形参绑定（形参名 → 已解析的实参类型），解析泛型声明的
 *                 类型体时传入；形参名在 resolveTypeReference 入口优先命中，
 *                 遮蔽同名的真实类型声明
 */
export function resolveTypeNode(
  typeNode: ts.TypeNode,
  checker?: ts.TypeChecker,
  visited: Set<string> = new Set(),
  bindings: Map<string, RuntimeType> = new Map(),
): RuntimeType {
  const kind = typeNode.kind;

  // 基础类型
  switch (kind) {
    case ts.SyntaxKind.StringKeyword:
      return { kind: 'string' };
    case ts.SyntaxKind.NumberKeyword:
      return { kind: 'number' };
    case ts.SyntaxKind.BooleanKeyword:
      return { kind: 'boolean' };
    case ts.SyntaxKind.BigIntKeyword:
      // HTTP/JSON 不能传输 BigInt,在 AST 提取阶段就报错,避免运行时校验必然失败
      throw new SchemaExtractionError(
        typeNode.getText(),
        'bigint 无法通过 HTTP/JSON 传输,请改用 string 或 number',
      );
    case ts.SyntaxKind.SymbolKeyword:
      // HTTP/JSON 不能传输 Symbol
      throw new SchemaExtractionError(typeNode.getText(), 'symbol 无法通过 HTTP/JSON 传输');
    case ts.SyntaxKind.NullKeyword:
      return { kind: 'null' };
    case ts.SyntaxKind.UndefinedKeyword:
      return { kind: 'undefined' };
    case ts.SyntaxKind.UnknownKeyword:
      // unknown 是唯一允许的"不校验"显式声明
      return { kind: 'any' };
    case ts.SyntaxKind.AnyKeyword:
      throw new SchemaExtractionError(typeNode.getText(), 'any 不支持，请使用 unknown 表示不校验');
    case ts.SyntaxKind.VoidKeyword:
      throw new SchemaExtractionError(typeNode.getText(), 'void 不支持运行时校验');
    case ts.SyntaxKind.NeverKeyword:
      throw new SchemaExtractionError(typeNode.getText(), 'never 不支持运行时校验');
    case ts.SyntaxKind.ObjectKeyword:
      throw new SchemaExtractionError(
        typeNode.getText(),
        'object 不支持，请使用具体对象类型或 unknown',
      );
  }

  // 字面量类型
  if (ts.isLiteralTypeNode(typeNode)) {
    const literal = typeNode.literal;
    if (ts.isStringLiteral(literal)) {
      return { kind: 'literal', value: literal.text };
    }
    if (ts.isNumericLiteral(literal)) {
      return { kind: 'literal', value: Number(literal.text) };
    }
    if (literal.kind === ts.SyntaxKind.TrueKeyword) {
      return { kind: 'literal', value: true };
    }
    if (literal.kind === ts.SyntaxKind.FalseKeyword) {
      return { kind: 'literal', value: false };
    }
    if (literal.kind === ts.SyntaxKind.NullKeyword) {
      return { kind: 'null' };
    }
    throw new SchemaExtractionError(typeNode.getText(), '不支持的字面量类型');
  }

  // 数组类型：T[]
  if (ts.isArrayTypeNode(typeNode)) {
    return {
      kind: 'array',
      element: resolveTypeNode(typeNode.elementType, checker, visited, bindings),
    };
  }

  // 元组类型：[string, number] / [string, number?] / [string, ...number[]]
  if (ts.isTupleTypeNode(typeNode)) {
    const elements: TupleElement[] = typeNode.elements.map((e) => {
      // 剩余元素：...T
      if (ts.isRestTypeNode(e)) {
        const inner = resolveTypeNode(e.type, checker, visited, bindings);
        // ...T[] → 元素类型是 T 的数组元素
        if (inner.kind === 'array') {
          return { type: inner.element, optional: false, rest: true };
        }
        // ...T 但 T 不是数组（罕见,TS 通常要求 rest 是数组）
        return { type: inner, optional: false, rest: true };
      }
      // 命名元组成员：[name: string, age?: number]
      if (ts.isNamedTupleMember(e)) {
        return {
          type: resolveTypeNode(e.type, checker, visited, bindings),
          optional: !!e.questionToken,
          rest: false,
        };
      }
      // 可选元素：number?（无名称,有 ?）
      if (ts.isOptionalTypeNode(e)) {
        return {
          type: resolveTypeNode(e.type, checker, visited, bindings),
          optional: true,
          rest: false,
        };
      }
      // 普通元素
      return {
        type: resolveTypeNode(e, checker, visited, bindings),
        optional: false,
        rest: false,
      };
    });
    return { kind: 'tuple', elements };
  }

  // 联合类型：A | B
  if (ts.isUnionTypeNode(typeNode)) {
    const members = typeNode.types.map((t) => resolveTypeNode(t, checker, visited, bindings));
    return { kind: 'union', members };
  }

  // 交叉类型：A & B → 合并对象属性（全部成员均为 object 时）
  if (ts.isIntersectionTypeNode(typeNode)) {
    const properties: PropertyType[] = [];
    for (const t of typeNode.types) {
      const resolved = resolveTypeNode(t, checker, visited, bindings);
      if (resolved.kind !== 'object') {
        // branded 类型（string & {...}）等混合交叉在运行时无对应校验物——
        // 静默丢弃非 object 成员会放宽校验,按约定显式抛错（见 AGENTS.md §6.3）
        throw new SchemaExtractionError(
          typeNode.getText(),
          `交叉类型包含非 object 成员（${resolved.kind}）,运行时无法校验——branded 类型建议改用具体类型或 unknown`,
        );
      }
      properties.push(...resolved.properties);
    }
    return { kind: 'object', properties };
  }

  // 内联对象类型：{ name: string; age?: number }
  if (ts.isTypeLiteralNode(typeNode)) {
    return resolveTypeLiteral(typeNode, checker, visited, bindings);
  }

  // keyof T — 用 checker 解析为字面量联合
  if (ts.isTypeOperatorNode(typeNode) && typeNode.operator === ts.SyntaxKind.KeyOfKeyword) {
    return resolveKeyOf(typeNode, checker);
  }

  // readonly T（如 readonly string[] / readonly [T, U]）— 编译期约束，运行时不校验
  // 递归解析内部类型即可，等同于去掉 readonly 修饰符
  if (ts.isTypeOperatorNode(typeNode) && typeNode.operator === ts.SyntaxKind.ReadonlyKeyword) {
    return resolveTypeNode(typeNode.type, checker, visited, bindings);
  }

  // 引用类型：Date / 自定义 interface / Array<T> / Record<K,V> / Partial<T> 等
  if (ts.isTypeReferenceNode(typeNode)) {
    return resolveTypeReference(typeNode, checker, visited, bindings);
  }

  // interface extends 的 heritage 子句（ExpressionWithTypeArguments）
  // 构造 TypeRefLike 视图（expression → typeName），复用 resolveTypeReference
  // 解析（覆盖 Date / Array<T> / 自定义 interface 等全部分支）
  if (ts.isExpressionWithTypeArguments(typeNode)) {
    return resolveTypeReference(
      {
        getText: () => typeNode.getText(),
        typeName: typeNode.expression as ts.EntityName,
        typeArguments: typeNode.typeArguments,
      },
      checker,
      visited,
      bindings,
    );
  }

  // 其他无法识别的语法节点
  throw new SchemaExtractionError(typeNode.getText(), '不支持的类型语法');
}

/**
 * 解析内联对象类型字面量
 */
function resolveTypeLiteral(
  typeNode: ts.TypeLiteralNode,
  checker?: ts.TypeChecker,
  visited: Set<string> = new Set(),
  bindings: Map<string, RuntimeType> = new Map(),
): RuntimeType {
  const properties: PropertyType[] = [];
  // 索引签名（[k: string]: T）与属性共存合法：属性保留，索引签名转为 catchall
  let catchall: RuntimeType | undefined;

  for (const member of typeNode.members) {
    // 属性签名：name: string
    if (ts.isPropertySignature(member) && member.name) {
      const name = member.name.getText();
      const optional = !!member.questionToken;
      const type = member.type
        ? resolveTypeNode(member.type, checker, visited, bindings)
        : { kind: 'any' as const };
      const constraints = extractConstraintsFromJsDoc(member, name);
      validateConstraints(constraints, type, name);
      properties.push(
        constraints.length > 0 ? { name, type, optional, constraints } : { name, type, optional },
      );
    }
    // 索引签名：[key: string]: T → catchall（与属性共存时不丢弃属性）
    if (ts.isIndexSignatureDeclaration(member)) {
      catchall = member.type
        ? resolveTypeNode(member.type, checker, visited, bindings)
        : { kind: 'any' as const };
    }
  }

  return catchall !== undefined
    ? { kind: 'object', properties, catchall }
    : { kind: 'object', properties };
}

/**
 * 从 RuntimeType 提取字面量字符串集合
 * 用于 Pick<T, K> / Omit<T, K> 的 K 参数解析
 *
 * @returns 字面量值数组；无法解析时返回 null
 */
function extractLiteralKeys(type: RuntimeType): string[] | null {
  if (type.kind === 'literal' && typeof type.value === 'string') {
    return [type.value];
  }
  if (type.kind === 'union') {
    const keys: string[] = [];
    for (const member of type.members) {
      if (member.kind === 'literal' && typeof member.value === 'string') {
        keys.push(member.value);
      } else {
        return null;
      }
    }
    return keys;
  }
  return null;
}

/**
 * 用 checker 解析 K 的最终类型，提取字面量字符串集合
 *
 * 用于 Pick<T, K> / Omit<T, K> 的 K 参数解析，覆盖 AST 无法直接拿到的场景：
 * - K 为类型别名（type Keys = 'id' | 'name'）
 * - K 为 keyof T
 *
 * @returns 字面量值数组；无法解析时返回 null
 */
function extractKeysFromChecker(typeNode: ts.TypeNode, checker?: ts.TypeChecker): string[] | null {
  if (!checker) return null;
  const type = checker.getTypeFromTypeNode(typeNode);

  if (type.isUnion()) {
    const keys: string[] = [];
    for (const member of type.types) {
      if (member.isStringLiteral()) {
        keys.push(member.value);
      } else if (member.isNumberLiteral()) {
        keys.push(String(member.value));
      } else {
        return null;
      }
    }
    return keys;
  }

  if (type.isStringLiteral()) {
    return [type.value];
  }
  if (type.isNumberLiteral()) {
    return [String(type.value)];
  }

  return null;
}

/**
 * 解析 keyof T — 用 checker 计算最终类型，返回字面量联合
 *
 * 例如 keyof { id: number; name: string } → 'id' | 'name'
 */
function resolveKeyOf(typeNode: ts.TypeOperatorNode, checker?: ts.TypeChecker): RuntimeType {
  if (!checker) {
    throw new SchemaExtractionError(typeNode.getText(), 'keyof T 需要 checker 才能解析');
  }
  const type = checker.getTypeFromTypeNode(typeNode);

  if (type.isUnion()) {
    const members: RuntimeType[] = [];
    for (const member of type.types) {
      if (member.isStringLiteral()) {
        members.push({ kind: 'literal', value: member.value });
      } else if (member.isNumberLiteral()) {
        members.push({ kind: 'literal', value: member.value });
      } else {
        throw new SchemaExtractionError(typeNode.getText(), 'keyof T 的结果包含非字面量类型');
      }
    }
    return { kind: 'union', members };
  }

  if (type.isStringLiteral()) {
    return { kind: 'literal', value: type.value };
  }
  if (type.isNumberLiteral()) {
    return { kind: 'literal', value: type.value };
  }

  throw new SchemaExtractionError(typeNode.getText(), 'keyof T 的结果无法解析为字面量联合');
}

/**
 * resolveTypeReference 所需的最小节点结构
 *
 * TypeReferenceNode 与 interface extends 的 heritage 节点（ExpressionWithTypeArguments）
 * 均满足该结构——后者用 expression 充当 typeName，typeArguments 同名。
 */
interface TypeRefLike {
  getText(): string;
  typeName: ts.EntityName | ts.LeftHandSideExpression;
  typeArguments?: readonly ts.TypeNode[];
}

/**
 * 解析类型引用（Date / 自定义 interface / Array<T> / Record<K,V> 等）
 *
 * 泛型形参优先：typeName 命中 bindings 时直接返回绑定的实参类型
 * （泛型声明体内部引用形参的场景，形参遮蔽同名真实类型）。
 */
function resolveTypeReference(
  typeNode: TypeRefLike,
  checker?: ts.TypeChecker,
  visited: Set<string> = new Set(),
  bindings: Map<string, RuntimeType> = new Map(),
): RuntimeType {
  const typeName = typeNode.typeName.getText();

  // 泛型形参命中：直接返回已绑定的实参类型
  const bound = bindings.get(typeName);
  if (bound) {
    return bound;
  }

  // Date 类型
  if (typeName === 'Date') {
    return { kind: 'date' };
  }

  // Array<T> / ReadonlyArray<T> — 等同处理，readonly 是编译期约束
  if (
    (typeName === 'Array' || typeName === 'ReadonlyArray') &&
    typeNode.typeArguments?.length === 1
  ) {
    return {
      kind: 'array',
      element: resolveTypeNode(typeNode.typeArguments[0], checker, visited, bindings),
    };
  }

  // Record<K, V>
  if (typeName === 'Record' && typeNode.typeArguments?.length === 2) {
    return {
      kind: 'record',
      key: resolveTypeNode(typeNode.typeArguments[0], checker, visited, bindings),
      value: resolveTypeNode(typeNode.typeArguments[1], checker, visited, bindings),
    };
  }

  // Partial<T> / Required<T> / Readonly<T> — best effort，解析内部类型
  if (
    (typeName === 'Partial' || typeName === 'Required' || typeName === 'Readonly') &&
    typeNode.typeArguments?.length === 1
  ) {
    const inner = resolveTypeNode(typeNode.typeArguments[0], checker, visited, bindings);
    if (inner.kind === 'object' && typeName === 'Partial') {
      // Partial 所有字段变可选
      return {
        kind: 'object',
        properties: inner.properties.map((p) => ({ ...p, optional: true })),
      };
    }
    return inner;
  }

  // Pick<T, K> / Omit<T, K> — 解析 T 的字段，按 K 筛选/排除
  if ((typeName === 'Pick' || typeName === 'Omit') && typeNode.typeArguments?.length === 2) {
    const innerType = resolveTypeNode(typeNode.typeArguments[0], checker, visited, bindings);
    if (innerType.kind !== 'object') {
      throw new SchemaExtractionError(
        typeNode.getText(),
        `${typeName} 的 T 必须是对象类型，实际为 ${innerType.kind}`,
      );
    }

    // K 解析顺序：AST 字面量联合 → checker 解析（覆盖类型别名 / keyof T）
    const keyTypeNode = typeNode.typeArguments[1];
    let keys = extractLiteralKeys(resolveTypeNode(keyTypeNode, checker, visited, bindings));
    if (keys === null) {
      keys = extractKeysFromChecker(keyTypeNode, checker);
    }
    if (keys === null) {
      throw new SchemaExtractionError(typeNode.getText(), `${typeName} 的 K 无法解析为字面量集合`);
    }

    const keySet = new Set(keys);
    const properties =
      typeName === 'Pick'
        ? innerType.properties.filter((p) => keySet.has(p.name))
        : innerType.properties.filter((p) => !keySet.has(p.name));

    return { kind: 'object', properties };
  }

  // Map<K, V> — JSON 序列化为 entries 数组，运行时用 z.preprocess(coerceMap, z.map(...)) 还原
  if (typeName === 'Map') {
    if (!typeNode.typeArguments || typeNode.typeArguments.length !== 2) {
      throw new SchemaExtractionError(
        typeNode.getText(),
        'Map 必须带 2 个类型参数，如 Map<K, V>，裸 Map 不支持',
      );
    }
    return {
      kind: 'map',
      key: resolveTypeNode(typeNode.typeArguments[0], checker, visited, bindings),
      value: resolveTypeNode(typeNode.typeArguments[1], checker, visited, bindings),
    };
  }

  // Set<T> — JSON 序列化为数组，运行时用 z.preprocess(coerceSet, z.set(...)) 还原
  if (typeName === 'Set') {
    if (!typeNode.typeArguments || typeNode.typeArguments.length !== 1) {
      throw new SchemaExtractionError(
        typeNode.getText(),
        'Set 必须带 1 个类型参数，如 Set<T>，裸 Set 不支持',
      );
    }
    return {
      kind: 'set',
      element: resolveTypeNode(typeNode.typeArguments[0], checker, visited, bindings),
    };
  }

  // WeakMap / WeakSet — 运行时无法枚举校验，仍然抛错（Map/Set 不复用其语义）
  if (typeName === 'WeakMap' || typeName === 'WeakSet') {
    throw new SchemaExtractionError(
      typeNode.getText(),
      `${typeName} 运行时无法枚举校验，请改用 Map / Set 或对象`,
    );
  }

  // Promise<T> — 运行时无法校验异步值
  if (typeName === 'Promise') {
    throw new SchemaExtractionError(
      typeNode.getText(),
      'Promise 运行时无法校验，请勿在 query/body 类型中使用',
    );
  }

  // Function — HTTP/JSON 不能传输函数
  if (typeName === 'Function') {
    throw new SchemaExtractionError(typeNode.getText(), 'Function 无法通过 HTTP/JSON 传输');
  }

  // 防止递归循环：遇到已访问的类型返回 ref，支持循环引用
  if (visited.has(typeName)) {
    return { kind: 'ref', name: typeName };
  }
  visited.add(typeName);

  // 使用 checker 解析引用类型（interface / type 别名）
  if (checker) {
    const symbol =
      ts.isIdentifier(typeNode.typeName) || ts.isQualifiedName(typeNode.typeName)
        ? checker.getSymbolAtLocation(typeNode.typeName)
        : undefined;

    if (symbol) {
      const declaration = symbol.declarations?.[0];
      if (declaration) {
        // interface 声明
        if (ts.isInterfaceDeclaration(declaration)) {
          return resolveInterfaceDeclaration(
            declaration,
            checker,
            visited,
            bindings,
            typeNode.typeArguments,
          );
        }
        // type 别名声明
        if (ts.isTypeAliasDeclaration(declaration)) {
          const declBindings = bindTypeParameters(
            declaration.typeParameters,
            typeNode.typeArguments,
            bindings,
            checker,
            visited,
            typeNode,
          );
          return resolveTypeNode(declaration.type, checker, visited, declBindings);
        }
        // enum 声明 → 字面量联合
        if (ts.isEnumDeclaration(declaration)) {
          return resolveEnumDeclaration(declaration);
        }
        // import 别名（跨文件 import type）：跟到真实声明
        // 业务项目用 moduleResolution: Bundler + 无扩展名导入时,
        // checker 拿到的 symbol 是 ImportSpecifier(Alias),不是真实声明
        if (ts.isImportSpecifier(declaration) || ts.isImportClause(declaration)) {
          const resolved = resolveImportAlias(
            typeNode,
            symbol,
            checker,
            visited,
            bindings,
            typeNode.typeArguments,
          );
          if (resolved) return resolved;
        }
      }
    }
  }

  throw new SchemaExtractionError(typeNode.getText(), `无法解析的引用类型 "${typeName}"`);
}

/**
 * 绑定泛型形参与实参，返回声明体解析用的 bindings
 *
 * - 实参表达式在调用方作用域解析（用 outerBindings，可引用外层形参）
 * - 默认类型在声明方作用域解析（用正在构造的 bindings，可引用前面形参，如 `<T, U = T[]>`）
 * - 实参与默认类型均缺失时抛 SchemaExtractionError（TS 本身也编译不过，防御性报错）
 * - 声明无 typeParameters 时原样返回 outerBindings
 */
function bindTypeParameters(
  typeParameters: readonly ts.TypeParameterDeclaration[] | undefined,
  typeArguments: readonly ts.TypeNode[] | undefined,
  outerBindings: Map<string, RuntimeType>,
  checker: ts.TypeChecker | undefined,
  visited: Set<string>,
  errorNode: { getText(): string },
): Map<string, RuntimeType> {
  if (!typeParameters || typeParameters.length === 0) return outerBindings;

  const bindings = new Map(outerBindings);
  for (let i = 0; i < typeParameters.length; i++) {
    const param = typeParameters[i];
    if (!param) continue;
    const arg = typeArguments?.[i];
    if (arg) {
      bindings.set(param.name.text, resolveTypeNode(arg, checker, visited, outerBindings));
    } else if (param.default) {
      bindings.set(param.name.text, resolveTypeNode(param.default, checker, visited, bindings));
    } else {
      throw new SchemaExtractionError(
        errorNode.getText(),
        `泛型参数 "${param.name.text}" 缺少类型实参（且无默认类型）`,
      );
    }
  }
  return bindings;
}

/**
 * 解析 import 别名符号,跟到真实的 interface / type alias / enum 声明
 *
 * 业务项目用 `moduleResolution: Bundler` + 无扩展名相对导入(如
 * `import type { StyleGuide } from '../../db/schema'`)时,checker 拿到的 symbol
 * 是 `ImportSpecifier`(Alias symbol),不是真实声明节点。
 *
 * 解析顺序:
 * 1. `checker.getAliasedSymbol(symbol)` — 优先路径,直接跟到真实 symbol
 * 2. 兜底:遍历 program 的所有 sourceFiles 找名为 `typeName` 的
 *    `InterfaceDeclaration` / `TypeAliasDeclaration` / `EnumDeclaration`
 *
 * 兜底路径用于 `getAliasedSymbol` 在 `noEmit` 模式下未完全绑定 alias 的场景
 * (实测:即使业务项目 tsconfig 用 Bundler + program 加载了全部相关文件,
 * `getAliasedSymbol` 也可能返回 unknown / 无 declarations)。
 *
 * @returns RuntimeType 解析结果;无法解析返回 null(由调用方抛 SchemaExtractionError)
 */
function resolveImportAlias(
  typeNode: TypeRefLike,
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
  visited: Set<string>,
  bindings: Map<string, RuntimeType> = new Map(),
  typeArguments?: readonly ts.TypeNode[],
): RuntimeType | null {
  const typeName = typeNode.typeName.getText();

  // 路径1:getAliasedSymbol 直接跟到真实 symbol
  try {
    const aliased = checker.getAliasedSymbol(symbol);
    if (aliased && aliased.declarations && aliased.declarations.length > 0) {
      const decl = aliased.declarations[0];
      if (ts.isInterfaceDeclaration(decl)) {
        return resolveInterfaceDeclaration(decl, checker, visited, bindings, typeArguments);
      }
      if (ts.isTypeAliasDeclaration(decl)) {
        const declBindings = bindTypeParameters(
          decl.typeParameters,
          typeArguments,
          bindings,
          checker,
          visited,
          typeNode,
        );
        return resolveTypeNode(decl.type, checker, visited, declBindings);
      }
      if (ts.isEnumDeclaration(decl)) {
        return resolveEnumDeclaration(decl);
      }
    }
  } catch {
    // getAliasedSymbol 抛错时走兜底
  }

  // 路径2:兜底遍历 program 的 sourceFiles 找同名声明
  // 用模块级变量 currentProgram(createProgram 时通过 setProgramContext 设置)
  // TypeChecker 类型上声明了 getProgram() 但运行时未暴露,只能通过外部传入
  const program = currentProgram;
  if (!program) return null;

  const allSFs = program.getSourceFiles();
  for (const sourceFile of allSFs) {
    // 跳过 lib.d.ts / node_modules / TypeScript 内置文件
    if (
      sourceFile.fileName.includes('/node_modules/') ||
      sourceFile.fileName.includes('typescript/lib/')
    ) {
      continue;
    }
    // 顶层声明查找(用独立函数返回,避免 TS 控制流分析把闭包赋值的 let 变量收窄为 never)
    const found = findTopLevelDecl(sourceFile, typeName);
    if (found) {
      if (found.kind === 'interface') {
        return resolveInterfaceDeclaration(found.node, checker, visited, bindings, typeArguments);
      }
      if (found.kind === 'typeAlias') {
        const declBindings = bindTypeParameters(
          found.node.typeParameters,
          typeArguments,
          bindings,
          checker,
          visited,
          typeNode,
        );
        return resolveTypeNode(found.node.type, checker, visited, declBindings);
      }
      if (found.kind === 'enum') {
        return resolveEnumDeclaration(found.node);
      }
    }
  }

  return null;
}

/**
 * 在 sourceFile 顶层查找名为 typeName 的 interface / type alias / enum 声明
 *
 * 独立为函数是因为 TS 控制流分析对"闭包中赋值的 let 变量"保守处理:
 * 即使 forEachChild 同步调用回调,分析器仍认为赋值可能未发生,
 * 导致外层读取时变量被收窄为初始值类型(null)。
 * 用函数返回值(带显式返回类型)绕过此限制。
 */
type TopLevelDecl =
  | { kind: 'interface'; node: ts.InterfaceDeclaration }
  | { kind: 'typeAlias'; node: ts.TypeAliasDeclaration }
  | { kind: 'enum'; node: ts.EnumDeclaration };

function findTopLevelDecl(sourceFile: ts.SourceFile, typeName: string): TopLevelDecl | null {
  let found: TopLevelDecl | null = null;
  ts.forEachChild(sourceFile, (node) => {
    if (found) return;
    if (ts.isInterfaceDeclaration(node) && node.name.text === typeName) {
      found = { kind: 'interface', node };
    } else if (ts.isTypeAliasDeclaration(node) && node.name.text === typeName) {
      found = { kind: 'typeAlias', node };
    } else if (ts.isEnumDeclaration(node) && node.name.text === typeName) {
      found = { kind: 'enum', node };
    }
  });
  return found;
}

/**
 * 解析 enum 声明为字面量联合类型
 *
 * - 字符串枚举：`enum Role { Admin = 'admin' }` → `'admin' | ...`
 * - 数值枚举：`enum Code { OK = 200 }` → `200 | ...`
 * - 隐式数值枚举：`enum Dir { Up, Down }` → `0 | 1 | ...`
 *
 * HTTP 视角：枚举值在 JSON 中是普通 string/number,按字面量联合校验即可。
 */
function resolveEnumDeclaration(node: ts.EnumDeclaration): RuntimeType {
  const members: RuntimeType[] = [];
  let nextNumericValue = 0;

  for (const member of node.members) {
    if (member.initializer) {
      if (ts.isStringLiteral(member.initializer)) {
        members.push({ kind: 'literal', value: member.initializer.text });
      } else if (ts.isNumericLiteral(member.initializer)) {
        const num = Number(member.initializer.text);
        members.push({ kind: 'literal', value: num });
        nextNumericValue = num + 1;
      } else {
        throw new SchemaExtractionError(
          node.name.text,
          `enum 成员 "${member.name.getText()}" 的初始化值类型不支持,仅支持 string/number 字面量`,
        );
      }
    } else {
      // 隐式数值枚举:无初始化值,使用递增整数
      members.push({ kind: 'literal', value: nextNumericValue });
      nextNumericValue++;
    }
  }

  return { kind: 'union', members };
}

/**
 * 解析 interface 声明（含继承与泛型形参绑定）
 *
 * @param node interface 声明节点
 * @param checker 类型 checker
 * @param visited 防止递归循环
 * @param outerBindings 外层泛型形参绑定（调用方作用域）
 * @param typeArguments 本次引用携带的类型实参（如 `Base<string>` 的 [string]），
 *                      与 node.typeParameters 按位置配对构造声明体 bindings
 */
export function resolveInterfaceDeclaration(
  node: ts.InterfaceDeclaration,
  checker?: ts.TypeChecker,
  visited: Set<string> = new Set(),
  outerBindings: Map<string, RuntimeType> = new Map(),
  typeArguments?: readonly ts.TypeNode[],
): RuntimeType {
  const properties: PropertyType[] = [];
  const propMap = new Map<string, PropertyType>();
  // 索引签名（[k: string]: T）与属性共存合法：属性保留，索引签名转为 catchall
  let catchall: RuntimeType | undefined;

  // 绑定本声明的泛型形参（声明体与 heritage 均在该作用域下解析）
  const bindings = bindTypeParameters(
    node.typeParameters,
    typeArguments,
    outerBindings,
    checker,
    visited,
    node,
  );

  // 处理继承的父接口
  for (const heritageClause of node.heritageClauses ?? []) {
    if (heritageClause.token === ts.SyntaxKind.ExtendsKeyword) {
      for (const expr of heritageClause.types) {
        const parentType = resolveTypeNode(expr, checker, visited, bindings);
        if (parentType.kind === 'object') {
          for (const prop of parentType.properties) {
            propMap.set(prop.name, prop);
          }
        }
      }
    }
  }

  // 处理自身成员（覆盖继承的同名字段）
  for (const member of node.members) {
    if (ts.isPropertySignature(member) && member.name) {
      const name = member.name.getText();
      const optional = !!member.questionToken;
      const type = member.type
        ? resolveTypeNode(member.type, checker, visited, bindings)
        : { kind: 'any' as const };
      const constraints = extractConstraintsFromJsDoc(member, name);
      validateConstraints(constraints, type, name);
      propMap.set(
        name,
        constraints.length > 0 ? { name, type, optional, constraints } : { name, type, optional },
      );
    }
    // 索引签名 → catchall（与属性/继承属性共存时不丢弃）
    if (ts.isIndexSignatureDeclaration(member)) {
      catchall = member.type
        ? resolveTypeNode(member.type, checker, visited, bindings)
        : { kind: 'any' as const };
    }
  }

  for (const prop of propMap.values()) {
    properties.push(prop);
  }

  return catchall !== undefined
    ? { kind: 'object', properties, catchall }
    : { kind: 'object', properties };
}

/**
 * 数值约束标签集合（仅 number 字段）
 */
const NUMBER_CONSTRAINT_KINDS = new Set<TypeConstraint['kind']>([
  'max',
  'min',
  'int',
  'positive',
  'negative',
  'nonnegative',
  'nonpositive',
]);

/**
 * 长度约束标签集合（string 或 array 字段）
 */
const LENGTH_CONSTRAINT_KINDS = new Set<TypeConstraint['kind']>([
  'maxLength',
  'minLength',
  'length',
]);

/**
 * 字符串格式约束标签集合（仅 string 字段）
 */
const STRING_FORMAT_CONSTRAINT_KINDS = new Set<TypeConstraint['kind']>([
  'regex',
  'email',
  'url',
  'uuid',
]);

/**
 * 从字段的 JSDoc 注释中提取约束标签
 *
 * 解析 `/** ... *\/` 块注释中的 `@max`/`@min`/`@maxLength` 等标签。
 * 行内注释 `// @max 100` 不识别。
 *
 * @param node 字段节点（PropertySignature）
 * @param fieldName 字段名，用于错误信息
 * @returns 约束数组（无约束时返回空数组）
 */
function extractConstraintsFromJsDoc(
  node: ts.PropertySignature,
  fieldName: string,
): TypeConstraint[] {
  // ts.getJSDocCommentsAndTags 返回 JSDoc/JsDocTag 数组
  const jsDocs = ts
    .getJSDocCommentsAndTags(node)
    .filter((entry): entry is ts.JSDoc => ts.isJSDoc(entry));

  if (jsDocs.length === 0) return [];

  const constraints: TypeConstraint[] = [];

  for (const jsDoc of jsDocs) {
    if (!jsDoc.tags) continue;
    for (const tag of jsDoc.tags) {
      const constraint = parseJsDocTag(tag, fieldName);
      if (constraint) constraints.push(constraint);
    }
  }

  return constraints;
}

/**
 * 提取 JSDoc 标签后的文本注释
 *
 * `tag.comment` 类型为 `string | NodeArray<JSDocComment> | undefined`，
 * 此处仅取纯文本形式（约束标签后跟的均为字面量值，不会包含 JSDocLink 等节点）。
 *
 * @returns 标签后的文本；无文本或非纯字符串时返回 undefined
 */
function getTagCommentText(tag: ts.JSDocTag): string | undefined {
  const comment = tag.comment;
  if (typeof comment === 'string') return comment;
  return undefined;
}

/**
 * 解析单个 JSDoc 标签为约束
 *
 * @param tag JSDocTag 节点
 * @param fieldName 字段名，用于错误信息
 * @returns 约束对象；非约束标签返回 null
 */
function parseJsDocTag(tag: ts.JSDocTag, fieldName: string): TypeConstraint | null {
  const tagName = tag.tagName.text;

  switch (tagName) {
    // 数值约束（带值）
    case 'max':
    case 'min': {
      const value = parseNumberValue(tag, fieldName, tagName);
      return { kind: tagName, value };
    }

    // 长度约束（带值）
    case 'maxLength':
    case 'minLength':
    case 'length': {
      const value = parseNumberValue(tag, fieldName, tagName);
      return { kind: tagName, value };
    }

    // 正则约束（带 /pattern/flags 值）
    case 'regex':
    case 'pattern': {
      const text = getTagCommentText(tag);
      if (!text) {
        throw new SchemaExtractionError(fieldName, `@${tagName} 标签需要 /pattern/flags 形式的值`);
      }
      const regex = parseRegexLiteral(text.trim(), fieldName);
      return { kind: 'regex', pattern: regex.pattern, flags: regex.flags };
    }

    // 数值约束（无值）
    case 'int':
    case 'positive':
    case 'negative':
    case 'nonnegative':
    case 'nonpositive':
      return { kind: tagName };

    // 字符串格式约束（无值）
    case 'email':
    case 'url':
    case 'uuid':
      return { kind: tagName };

    default:
      return null;
  }
}

/**
 * 解析标签后的数字值
 *
 * @param tag JSDocTag 节点
 * @param fieldName 字段名，用于错误信息
 * @param tagName 标签名，用于错误信息
 */
function parseNumberValue(tag: ts.JSDocTag, fieldName: string, tagName: string): number {
  const text = getTagCommentText(tag);
  if (!text) {
    throw new SchemaExtractionError(fieldName, `@${tagName} 标签需要一个数字值`);
  }
  const trimmed = text.trim();
  const num = Number(trimmed);
  if (!Number.isFinite(num)) {
    throw new SchemaExtractionError(fieldName, `@${tagName} 标签的值 "${trimmed}" 不是有效数字`);
  }
  return num;
}

/**
 * 解析 /pattern/flags 形式的正则字面量
 *
 * @param text 标签后的文本，如 "/^[a-z]+$/i"
 * @param fieldName 字段名，用于错误信息
 */
function parseRegexLiteral(text: string, fieldName: string): { pattern: string; flags?: string } {
  // 必须以 / 开头，匹配结尾的 / 和可选 flags
  const match = /^\/(.+)\/([gimsuy]*)$/.exec(text);
  if (!match) {
    throw new SchemaExtractionError(fieldName, `正则值 "${text}" 不是 /pattern/flags 形式`);
  }
  const [, pattern, flags] = match;
  if (!pattern) {
    throw new SchemaExtractionError(fieldName, `正则值 "${text}" 的 pattern 部分为空`);
  }
  return flags ? { pattern, flags } : { pattern };
}

/**
 * 校验约束与字段类型是否匹配
 *
 * 不匹配时抛 SchemaExtractionError（复用现有错误类型）。
 *
 * @param constraints 约束数组
 * @param type 字段类型
 * @param fieldName 字段名，用于错误信息
 */
function validateConstraints(
  constraints: TypeConstraint[],
  type: RuntimeType,
  fieldName: string,
): void {
  if (constraints.length === 0) return;

  for (const constraint of constraints) {
    const kind = constraint.kind;

    if (NUMBER_CONSTRAINT_KINDS.has(kind)) {
      if (type.kind !== 'number') {
        throw new SchemaExtractionError(
          fieldName,
          `@${kind} 约束仅适用于 number 字段，实际为 ${type.kind}`,
        );
      }
      continue;
    }

    if (LENGTH_CONSTRAINT_KINDS.has(kind)) {
      if (type.kind !== 'string' && type.kind !== 'array') {
        throw new SchemaExtractionError(
          fieldName,
          `@${kind} 约束仅适用于 string 或 array 字段，实际为 ${type.kind}`,
        );
      }
      continue;
    }

    if (STRING_FORMAT_CONSTRAINT_KINDS.has(kind)) {
      if (type.kind !== 'string') {
        throw new SchemaExtractionError(
          fieldName,
          `@${kind} 约束仅适用于 string 字段，实际为 ${type.kind}`,
        );
      }
      continue;
    }
  }
}
