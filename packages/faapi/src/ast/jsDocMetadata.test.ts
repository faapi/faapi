import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import {
  hasExportModifier,
  getJSDocFromNode,
  extractDescription,
  extractJSDocTagValue,
} from './jsDocMetadata';

/** 解析源码并返回第一个匹配名称的顶层节点 */
function firstDecl(source: string): ts.Node {
  const sf = ts.createSourceFile('temp.ts', source, ts.ScriptTarget.Latest, true);
  let found: ts.Node | undefined;
  ts.forEachChild(sf, (node) => {
    if (!found && ts.isFunctionDeclaration(node)) found = node;
  });
  if (!found) throw new Error('no function declaration in source');
  return found;
}

describe('hasExportModifier', () => {
  it('export 函数返回 true', () => {
    const node = firstDecl('export function GET() {}\n');
    expect(hasExportModifier(node)).toBe(true);
  });

  it('非 export 函数返回 false', () => {
    const node = firstDecl('function GET() {}\n');
    expect(hasExportModifier(node)).toBe(false);
  });

  it('export default 返回 true', () => {
    const node = firstDecl('export default function GET() {}\n');
    expect(hasExportModifier(node)).toBe(true);
  });
});

describe('getJSDocFromNode', () => {
  it('标准 JSDoc 注释块可提取', () => {
    const node = firstDecl('/** 描述文本 */\nexport function GET() {}\n');
    const jsDoc = getJSDocFromNode(node);
    expect(jsDoc).toBeDefined();
    expect(extractDescription(jsDoc)).toBe('描述文本');
  });

  it('无注释返回 undefined', () => {
    const node = firstDecl('export function GET() {}\n');
    expect(getJSDocFromNode(node)).toBeUndefined();
  });
});

describe('extractDescription', () => {
  it('undefined 输入返回 undefined', () => {
    expect(extractDescription(undefined)).toBeUndefined();
  });

  it('描述仅空白返回 undefined', () => {
    const node = firstDecl('/**   */\nexport function GET() {}\n');
    expect(extractDescription(getJSDocFromNode(node))).toBeUndefined();
  });

  it('多行描述保留换行', () => {
    const node = firstDecl('/** 第一行\n * 第二行 */\nexport function GET() {}\n');
    expect(extractDescription(getJSDocFromNode(node))).toBe('第一行\n第二行');
  });
});

describe('extractJSDocTagValue', () => {
  it('@tool 标签值提取', () => {
    const node = firstDecl('/** 描述\n * @tool weather.current\n */\nexport function GET() {}\n');
    expect(extractJSDocTagValue(getJSDocFromNode(node), 'tool')).toBe('weather.current');
  });

  it('@agent 标签值提取', () => {
    const node = firstDecl('/** @agent researcher */\nexport function GET() {}\n');
    expect(extractJSDocTagValue(getJSDocFromNode(node), 'agent')).toBe('researcher');
  });

  it('花括号包裹去花括号', () => {
    const node = firstDecl('/** @tool {custom} */\nexport function GET() {}\n');
    expect(extractJSDocTagValue(getJSDocFromNode(node), 'tool')).toBe('custom');
  });

  it('无指定标签返回 undefined', () => {
    const node = firstDecl('/** 描述\n * @other x\n */\nexport function GET() {}\n');
    expect(extractJSDocTagValue(getJSDocFromNode(node), 'tool')).toBeUndefined();
  });

  it('标签无 comment 文本返回 undefined', () => {
    const node = firstDecl('/** @tool */\nexport function GET() {}\n');
    expect(extractJSDocTagValue(getJSDocFromNode(node), 'tool')).toBeUndefined();
  });

  it('undefined 输入返回 undefined', () => {
    expect(extractJSDocTagValue(undefined, 'tool')).toBeUndefined();
  });
});
