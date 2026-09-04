import ts from 'typescript';
import {
  resolveTypeNode,
  resolveInterfaceDeclaration,
  setProgramContext,
  type PropertyType,
  type RuntimeType,
  SchemaExtractionError,
} from './resolveTypeNode';

export interface HandlerTypeInfo {
  name: string; // 类型名，如 'GETQuery'
  properties: PropertyType[];
  /** 完整的运行时类型描述（用于嵌套校验） */
  runtimeType: RuntimeType;
}

/**
 * 从源文件中提取指定名称的类型信息
 *
 * 支持的类型声明：
 * - interface 声明（含继承）
 * - type 别名（type Query = { ... }）
 *
 * 遇到不支持的类型时抛 `SchemaExtractionError`，错误信息包含文件路径和类型名。
 *
 * @param program TypeScript Program
 * @param filePath 源文件路径
 * @param typeName 类型名，如 'GETQuery'
 */
export function extractTypeInfo(
  program: ts.Program,
  filePath: string,
  typeName: string,
): HandlerTypeInfo | null {
  const sourceFile = program.getSourceFile(filePath);
  if (!sourceFile) return null;

  const checker = program.getTypeChecker();

  // 设置 program 上下文,供 resolveImportAlias 兜底遍历跨文件声明使用
  // (TypeChecker 运行时未暴露 getProgram(),通过模块级变量传入)
  setProgramContext(program);
  try {
    // 1. 查找 interface 声明
    let result: HandlerTypeInfo | null = null;

    ts.forEachChild(sourceFile, (node) => {
      if (result) return;

      if (ts.isInterfaceDeclaration(node) && node.name.text === typeName) {
        const visited = new Set<string>();
        visited.add(typeName); // 标记当前类型，使自引用直接返回 ref
        const runtimeType = withFileContext(filePath, typeName, () =>
          resolveInterfaceDeclaration(node, checker, visited),
        );
        result = {
          name: typeName,
          properties: runtimeType.kind === 'object' ? runtimeType.properties : [],
          runtimeType,
        };
        return;
      }

      // 2. 查找 type 别名
      if (ts.isTypeAliasDeclaration(node) && node.name.text === typeName) {
        const visited = new Set<string>();
        visited.add(typeName); // 标记当前类型，使自引用直接返回 ref
        const runtimeType = withFileContext(filePath, typeName, () =>
          resolveTypeNode(node.type, checker, visited),
        );
        result = {
          name: typeName,
          properties: runtimeType.kind === 'object' ? runtimeType.properties : [],
          runtimeType,
        };
        return;
      }
    });

    return result;
  } finally {
    setProgramContext(null);
  }
}

/**
 * 从源文件中提取所有 interface 和 type 别名的类型信息
 *
 * 用于：
 * - 生成 schema 模块时遍历所有命名类型
 * - 作为 typeResolver 提供给 generateZodSchema，解析循环引用中的 ref
 *
 * @returns Map<类型名, HandlerTypeInfo>
 */
export function extractAllTypes(
  program: ts.Program,
  filePath: string,
): Map<string, HandlerTypeInfo> {
  const sourceFile = program.getSourceFile(filePath);
  if (!sourceFile) return new Map();

  const checker = program.getTypeChecker();

  // 设置 program 上下文,供 resolveImportAlias 兜底遍历跨文件声明使用
  setProgramContext(program);
  try {
    const result = new Map<string, HandlerTypeInfo>();

    ts.forEachChild(sourceFile, (node) => {
      if (ts.isInterfaceDeclaration(node)) {
        const visited = new Set<string>();
        visited.add(node.name.text); // 标记当前类型，使自引用直接返回 ref
        const runtimeType = withFileContext(filePath, node.name.text, () =>
          resolveInterfaceDeclaration(node, checker, visited),
        );
        result.set(node.name.text, {
          name: node.name.text,
          properties: runtimeType.kind === 'object' ? runtimeType.properties : [],
          runtimeType,
        });
        return;
      }

      if (ts.isTypeAliasDeclaration(node)) {
        const visited = new Set<string>();
        visited.add(node.name.text); // 标记当前类型，使自引用直接返回 ref
        const runtimeType = withFileContext(filePath, node.name.text, () =>
          resolveTypeNode(node.type, checker, visited),
        );
        result.set(node.name.text, {
          name: node.name.text,
          properties: runtimeType.kind === 'object' ? runtimeType.properties : [],
          runtimeType,
        });
        return;
      }
    });

    return result;
  } finally {
    setProgramContext(null);
  }
}

/**
 * 惰性类型解析器
 *
 * 按名称解析类型并缓存。与 extractAllTypes 的差异：extractAllTypes 提前解析
 * 文件中全部顶层类型——与路由无关的类型也会被解析，其中任何类型含不支持语法
 * 都会拖垮整个 build/reload；惰性解析器只在类型真正被需要时（入口类型或
 * ref 引用）才解析，无关类型零开销。
 */
export interface LazyTypeResolver {
  /**
   * 按名称解析类型
   *
   * @returns 类型信息；文件中无该名称的声明时返回 null
   * @throws SchemaExtractionError 类型声明含不支持语法时（与 extractTypeInfo 一致，不降级）
   */
  resolve(name: string): HandlerTypeInfo | null;
}

/**
 * 创建文件的惰性类型解析器
 *
 * 缓存保证同一类型只解析一次（幂等返回同一实例）。
 *
 * @param program TypeScript Program（解析期间会临时设置 program 上下文，供
 *                resolveImportAlias 兜底遍历跨文件声明使用）
 * @param filePath 源文件绝对路径
 */
export function createLazyTypeResolver(program: ts.Program, filePath: string): LazyTypeResolver {
  const cache = new Map<string, HandlerTypeInfo | null>();
  return {
    resolve(name: string): HandlerTypeInfo | null {
      if (cache.has(name)) return cache.get(name)!;
      const info = extractTypeInfo(program, filePath, name);
      cache.set(name, info);
      return info;
    },
  };
}

/**
 * 包装类型解析，捕获 SchemaExtractionError 并补充文件路径和类型名上下文
 *
 * 只包装一次（最外层），避免嵌套调用时重复包装。
 */
function withFileContext<T>(filePath: string, typeName: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof SchemaExtractionError) {
      // 补充文件路径和类型名，只包装一次
      const fileName = filePath.split('/').pop() ?? filePath;
      const enriched = new SchemaExtractionError(
        err.typeText,
        `${err.reason}（文件: ${fileName}, 类型: ${typeName}）`,
        { cause: err },
      );
      throw enriched;
    }
    throw err;
  }
}
