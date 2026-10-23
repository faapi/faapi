import { describe, it, expect } from 'vitest';
import { renderPromptTemplate } from './promptTemplate';

describe('renderPromptTemplate', () => {
  it('基本插值:{{name}} 替换为 vars 对应值', () => {
    expect(renderPromptTemplate('你好,{{name}}!', { name: 'world' })).toBe('你好,world!');
  });

  it('点路径下钻:{{item.title}} / 下划线段名', () => {
    const tpl = '- 章节标题:{{item.title}}\n- 阶段上限:{{item.max_stage_count_for_chunk}}';
    expect(
      renderPromptTemplate(tpl, {
        item: { title: '第 3 章', max_stage_count_for_chunk: 8 },
      }),
    ).toBe('- 章节标题:第 3 章\n- 阶段上限:8');
  });

  it('容忍空白:{{ name }} 与 {{ item.title }}', () => {
    expect(
      renderPromptTemplate('{{ name }}/{{ item.title }}', { name: 'a', item: { title: 'b' } }),
    ).toBe('a/b');
  });

  it('同一占位符多次出现全部替换', () => {
    expect(renderPromptTemplate('{{x}}+{{x}}={{x}}{{x}}', { x: 1 })).toBe('1+1=11');
  });

  it('string 值原样（含换行）', () => {
    expect(renderPromptTemplate('{{content}}', { content: '第一段\n第二段' })).toBe(
      '第一段\n第二段',
    );
  });

  it('number/boolean/bigint → String（含 0 与 false）', () => {
    expect(
      renderPromptTemplate('{{n}} {{z}} {{b}} {{big}}', { n: 3, z: 0, b: false, big: 10n }),
    ).toBe('3 0 false 10');
  });

  it('object/array → JSON.stringify', () => {
    expect(renderPromptTemplate('{{item}}', { item: { a: 1 } })).toBe('{"a":1}');
    expect(renderPromptTemplate('{{list}}', { list: [1, 'x'] })).toBe('[1,"x"]');
  });

  it('缺键 → 抛错且带占位符名', () => {
    expect(() => renderPromptTemplate('{{missing}}', {})).toThrow(/missing/);
    expect(() => renderPromptTemplate('{{item.title}}', { item: {} })).toThrow(/item\.title/);
  });

  it('值为 null / undefined → 按缺失抛错', () => {
    expect(() => renderPromptTemplate('{{a}}', { a: null })).toThrow(/missing|\{\{a\}\}/);
    expect(() => renderPromptTemplate('{{a}}', { a: undefined })).toThrow();
  });

  it('中间路径为 null 或标量 → 按缺失抛错', () => {
    expect(() => renderPromptTemplate('{{a.b}}', { a: null })).toThrow();
    expect(() => renderPromptTemplate('{{a.b}}', { a: 'scalar' })).toThrow();
    expect(() => renderPromptTemplate('{{a.b.c}}', { a: { b: 1 } })).toThrow();
  });

  it('原型链键不参与解析:{{constructor}} 按缺失抛错', () => {
    expect(() => renderPromptTemplate('{{constructor}}', {})).toThrow();
    expect(() => renderPromptTemplate('{{constructor.name}}', {})).toThrow();
    expect(() => renderPromptTemplate('{{__proto__.x}}', {})).toThrow();
  });

  it('转义:\\{{name}} → 字面量 {{name}}（vars 有值也不插值）', () => {
    expect(renderPromptTemplate('\\{{name}}', { name: 'x' })).toBe('{{name}}');
    expect(renderPromptTemplate('模板语法 \\{{字段名}} 示例', {})).toBe('模板语法 {{字段名}} 示例');
  });

  it('无占位符原样透传（单花括号 / JSON 文本不受影响）', () => {
    const tpl = '输出 {"op":"done"} 表示完成,普通 { 单花括号 } 原样。';
    expect(renderPromptTemplate(tpl, {})).toBe(tpl);
  });

  it('非法占位符语法 → 抛错（空 / 空格 / 中文 / 空段）', () => {
    expect(() => renderPromptTemplate('{{}}', {})).toThrow(/非法占位符/);
    expect(() => renderPromptTemplate('{{a b}}', {})).toThrow(/非法占位符/);
    expect(() => renderPromptTemplate('{{标题}}', {})).toThrow(/非法占位符/);
    expect(() => renderPromptTemplate('{{a..b}}', {})).toThrow(/非法占位符/);
  });

  it('$ 开头段名合法', () => {
    expect(renderPromptTemplate('{{$index}}', { $index: 2 })).toBe('2');
  });
});
