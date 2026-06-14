import ts from 'typescript';
import type { InjectionType } from './resolveInjection';
import { PARAM_TYPE_MAP } from './resolveInjection';

/**
 * 参数元数据
 */
export interface ParamMeta {
  name: string; // 参数名
  type: InjectionType; // 注入类型
  typeName?: string; // 引用类型名（如 'Query'）
  schema?: PropertyInfo[]; // 类型结构（内联类型时）
}

/**
 * 属性信息
 */
export interface PropertyInfo {
  name: string;
  type: string;
  optional: boolean;
}

/**
 * 注入元数据
 */
export interface InjectionMeta {
  params: ParamMeta[];
}

/**
 * AST 分析 handler 函数，提取参数注入元数据
 */
export function analyzeInjection(code: string, functionName: string): InjectionMeta {
  const sourceFile = ts.createSourceFile('temp.ts', code, ts.ScriptTarget.Latest, true);

  const params: ParamMeta[] = [];

  // 遍历 AST 查找目标函数
  ts.forEachChild(sourceFile, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === functionName) {
      // 分析参数
      for (const param of node.parameters) {
        const paramMeta = analyzeParam(param, sourceFile);
        params.push(paramMeta);
      }
    }
  });

  return { params };
}

/**
 * 分析单个参数
 */
function analyzeParam(param: ts.ParameterDeclaration, sourceFile: ts.SourceFile): ParamMeta {
  const name = param.name.getText(sourceFile);
  const type = PARAM_TYPE_MAP[name] || 'unknown';

  const result: ParamMeta = { name, type };

  // 分析类型
  if (param.type) {
    if (ts.isTypeReferenceNode(param.type)) {
      // 引用类型：Query, Body 等
      result.typeName = param.type.typeName.getText(sourceFile);
    } else if (ts.isTypeLiteralNode(param.type)) {
      // 内联类型：{ page: number }
      result.schema = extractSchema(param.type, sourceFile);
    }
  }

  return result;
}

/**
 * 从类型字面量提取 schema
 */
function extractSchema(typeNode: ts.TypeLiteralNode, sourceFile: ts.SourceFile): PropertyInfo[] {
  const schema: PropertyInfo[] = [];

  for (const member of typeNode.members) {
    if (ts.isPropertySignature(member) && member.name && ts.isIdentifier(member.name)) {
      const propName = member.name.text;
      const optional = !!member.questionToken;
      const propType = member.type?.getText(sourceFile) || 'unknown';

      schema.push({
        name: propName,
        type: propType,
        optional,
      });
    }
  }

  return schema;
}
