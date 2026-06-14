import ts from 'typescript';

/**
 * 参数注入类型
 */
export type InjectionType =
  | 'query'
  | 'body'
  | 'headers'
  | 'params'
  | 'context'
  | 'cookies'
  | 'files'
  | 'fields'
  | 'unknown';

/**
 * 注入项信息
 */
export interface InjectionItem {
  name: string; // 参数名
  type: InjectionType; // 注入类型
  hasType: boolean; // 是否有类型标注（运行时类型已擦除，始终为 false）
}

/**
 * 参数名到注入类型的映射（单一来源，构建期和运行时共用）
 */
export const PARAM_TYPE_MAP: Record<string, InjectionType> = {
  query: 'query',
  body: 'body',
  headers: 'headers',
  params: 'params',
  context: 'context',
  ctx: 'context', // 别名
  cookies: 'cookies',
  files: 'files',
  fields: 'fields',
};

/**
 * 分析函数参数，决定需要注入什么内容
 *
 * 使用 TypeScript AST 解析 fn.toString() 的结果，
 * 正确处理解构参数、默认值、rest 参数等情况。
 *
 * 注意：运行时类型信息已被擦除，hasType 始终为 false。
 */
export function resolveInjection(fn: (...args: unknown[]) => unknown): InjectionItem[] {
  const fnStr = fn.toString();
  const params = extractParamsWithAst(fnStr);

  return params.map((param) => {
    const type = PARAM_TYPE_MAP[param.name] || 'unknown';
    return {
      name: param.name,
      type,
      hasType: false, // 运行时类型已擦除
    };
  });
}

/**
 * 使用 TypeScript AST 从函数字符串中提取参数名
 *
 * 相比正则解析，AST 能正确处理：
 * - 解构参数 `function GET({ page, size })` → page, size
 * - 默认值 `function GET(query = {})` → query
 * - rest 参数 `function GET(...args)` → args
 * - 含逗号的泛型（类型擦除后不存在该问题）
 */
function extractParamsWithAst(fnStr: string): Array<{ name: string }> {
  // 包装成模块，让 TS 能解析
  const sourceFile = ts.createSourceFile(
    '__faapi_injection__.ts',
    fnStr,
    ts.ScriptTarget.Latest,
    true,
  );

  const paramNames: string[] = [];

  function visit(node: ts.Node): void {
    // 函数声明：function GET(query) {}
    if (ts.isFunctionDeclaration(node) && node.parameters.length > 0) {
      for (const param of node.parameters) {
        extractParamName(param, paramNames);
      }
      return;
    }

    // 箭头函数 / 函数表达式：(query) => {} 或 function(query) {}
    if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && node.parameters.length > 0) {
      for (const param of node.parameters) {
        extractParamName(param, paramNames);
      }
      return;
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  return paramNames.map((name) => ({ name }));
}

/**
 * 从单个参数节点提取参数名
 *
 * 支持的参数形式：
 * - 标识符：query → query
 * - 解构对象：{ page, size } → page, size（每个属性都作为一个注入项）
 * - 解构数组：[a, b] → a, b
 * - rest 参数：...args → args
 * - 默认值：query = {} → query
 */
function extractParamName(param: ts.ParameterDeclaration, names: string[]): void {
  const name = param.name;

  // 标识符：query
  if (ts.isIdentifier(name)) {
    names.push(name.text);
    return;
  }

  // 解构对象：{ page, size }
  if (ts.isObjectBindingPattern(name)) {
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) {
        const elemName = element.name;
        if (ts.isIdentifier(elemName)) {
          names.push(elemName.text);
        }
      }
    }
    return;
  }

  // 解构数组：[a, b]
  if (ts.isArrayBindingPattern(name)) {
    for (const element of name.elements) {
      if (element && ts.isBindingElement(element)) {
        const elemName = element.name;
        if (ts.isIdentifier(elemName)) {
          names.push(elemName.text);
        }
      }
    }
    return;
  }
}
