import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProgram } from './createProgram';
import { extractAllTypes } from './extractHandlerTypes';
import {
  generateValidatorSource,
  generateSchemaModule,
  type SchemaModuleEntry,
  type ValidationResult,
} from './generateValidatorCode';

/**
 * 从 TypeScript 源码提取类型信息并生成校验函数
 *
 * 使用 extractAllTypes 提取所有类型，作为 typeResolver 传给生成器，
 * 这样循环引用中的 ref 能被正确解析。
 */
function makeValidator(source: string, typeName: string) {
  const dir = join(tmpdir(), `faapi-gen-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'test.ts');
  writeFileSync(file, source);
  const program = createProgram(file);
  const allTypes = extractAllTypes(program, file);
  const info = allTypes.get(typeName);
  if (!info) throw new Error(`类型 ${typeName} 未找到`);
  const sourceCode = generateValidatorSource(info, (name) => allTypes.get(name)?.runtimeType);
  // 包装成可执行函数
  const fn = new Function('input', `${sourceCode}\nreturn validate(input);`) as (
    input: unknown,
  ) => ValidationResult;
  rmSync(dir, { recursive: true, force: true });
  return fn;
}

describe('generateValidatorSource', () => {
  describe('基础类型', () => {
    it('string 类型校验', () => {
      const validate = makeValidator(`export interface Q { name: string; }`, 'Q');
      expect(validate({ name: 'foo' }).valid).toBe(true);
      expect(validate({ name: 123 }).valid).toBe(false);
      expect(validate({}).valid).toBe(false); // 缺少必填字段
    });

    it('number 类型校验', () => {
      const validate = makeValidator(`export interface Q { age: number; }`, 'Q');
      expect(validate({ age: 18 }).valid).toBe(true);
      expect(validate({ age: '18' }).valid).toBe(false);
      expect(validate({ age: NaN }).valid).toBe(false);
    });

    it('boolean 类型校验', () => {
      const validate = makeValidator(`export interface Q { active: boolean; }`, 'Q');
      expect(validate({ active: true }).valid).toBe(true);
      expect(validate({ active: 'true' }).valid).toBe(false);
    });

    it('bigint 类型在 AST 提取阶段抛 SchemaExtractionError（HTTP 不能传输）', () => {
      expect(() => makeValidator(`export interface Q { id: bigint; }`, 'Q')).toThrow(
        /bigint.*HTTP\/JSON.*传输/,
      );
    });

    it('symbol 类型在 AST 提取阶段抛 SchemaExtractionError（HTTP 不能传输）', () => {
      expect(() => makeValidator(`export interface Q { id: symbol; }`, 'Q')).toThrow(
        /symbol.*HTTP\/JSON.*传输/,
      );
    });

    it('Function 类型在 AST 提取阶段抛 SchemaExtractionError（HTTP 不能传输）', () => {
      expect(() => makeValidator(`export interface Q { cb: Function; }`, 'Q')).toThrow(
        /Function.*HTTP\/JSON.*传输/,
      );
    });
  });

  describe('可选字段', () => {
    it('可选字段缺失时通过', () => {
      const validate = makeValidator(`export interface Q { name: string; age?: number; }`, 'Q');
      expect(validate({ name: 'foo' }).valid).toBe(true);
      expect(validate({ name: 'foo', age: 18 }).valid).toBe(true);
      expect(validate({ name: 'foo', age: '18' }).valid).toBe(false);
    });

    it('可选字段传 null 必须显式声明 null（非 null 类型报错）', () => {
      // name?: string 传 null → 报 TYPE_MISMATCH（不能传 null,除非声明 string | null）
      const validate = makeValidator(`export interface Q { name?: string; }`, 'Q');
      const r = validate({ name: null });
      expect(r.valid).toBe(false);
      expect(r.issues[0].code).toBe('TYPE_MISMATCH');
      expect(r.issues[0].expected).toBe('string');
      expect(r.issues[0].received).toBe('object'); // typeof null === 'object'
    });

    it('显式声明 string | null 传 null 通过', () => {
      const validate = makeValidator(`export interface Q { name: string | null; }`, 'Q');
      expect(validate({ name: null }).valid).toBe(true);
      expect(validate({ name: 'foo' }).valid).toBe(true);
      expect(validate({ name: 123 }).valid).toBe(false);
    });

    it('可选字段显式声明 string | null,缺失时也通过', () => {
      const validate = makeValidator(`export interface Q { name?: string | null; }`, 'Q');
      expect(validate({}).valid).toBe(true);
      expect(validate({ name: null }).valid).toBe(true);
      expect(validate({ name: 'foo' }).valid).toBe(true);
    });

    it('必填字段传 null 非 null 类型报错', () => {
      const validate = makeValidator(`export interface Q { name: string; }`, 'Q');
      const r = validate({ name: null });
      expect(r.valid).toBe(false);
      expect(r.issues[0].code).toBe('TYPE_MISMATCH');
    });
  });

  describe('字面量类型', () => {
    it('字符串字面量', () => {
      const validate = makeValidator(`export interface Q { role: 'admin' | 'user'; }`, 'Q');
      expect(validate({ role: 'admin' }).valid).toBe(true);
      expect(validate({ role: 'user' }).valid).toBe(true);
      expect(validate({ role: 'guest' }).valid).toBe(false);
    });

    it('数字字面量', () => {
      const validate = makeValidator(`export interface Q { code: 200 | 404; }`, 'Q');
      expect(validate({ code: 200 }).valid).toBe(true);
      expect(validate({ code: 500 }).valid).toBe(false);
    });

    it('布尔字面量', () => {
      const validate = makeValidator(`export interface Q { flag: true; }`, 'Q');
      expect(validate({ flag: true }).valid).toBe(true);
      expect(validate({ flag: false }).valid).toBe(false);
    });
  });

  describe('enum 类型', () => {
    it('字符串枚举校验', () => {
      const validate = makeValidator(
        `enum Role { Admin = 'admin', User = 'user' }\nexport interface Q { role: Role; }`,
        'Q',
      );
      expect(validate({ role: 'admin' }).valid).toBe(true);
      expect(validate({ role: 'user' }).valid).toBe(true);
      expect(validate({ role: 'guest' }).valid).toBe(false);
      expect(validate({ role: 0 }).valid).toBe(false);
    });

    it('数值枚举校验', () => {
      const validate = makeValidator(
        `enum Code { OK = 200, NotFound = 404 }\nexport interface Q { code: Code; }`,
        'Q',
      );
      expect(validate({ code: 200 }).valid).toBe(true);
      expect(validate({ code: 404 }).valid).toBe(true);
      expect(validate({ code: 500 }).valid).toBe(false);
      expect(validate({ code: '200' }).valid).toBe(false);
    });

    it('隐式数值枚举校验', () => {
      const validate = makeValidator(
        `enum Dir { Up, Down, Left, Right }\nexport interface Q { dir: Dir; }`,
        'Q',
      );
      expect(validate({ dir: 0 }).valid).toBe(true);
      expect(validate({ dir: 1 }).valid).toBe(true);
      expect(validate({ dir: 3 }).valid).toBe(true);
      expect(validate({ dir: 4 }).valid).toBe(false);
    });
  });

  describe('数组类型', () => {
    it('string 数组', () => {
      const validate = makeValidator(`export interface Q { tags: string[]; }`, 'Q');
      expect(validate({ tags: ['a', 'b'] }).valid).toBe(true);
      expect(validate({ tags: 'a' }).valid).toBe(false);
      expect(validate({ tags: [1] }).valid).toBe(false);
    });

    it('嵌套对象数组', () => {
      const validate = makeValidator(`export interface Q { items: Array<{ id: number }>; }`, 'Q');
      expect(validate({ items: [{ id: 1 }, { id: 2 }] }).valid).toBe(true);
      expect(validate({ items: [{ id: '1' }] }).valid).toBe(false);
      expect(validate({ items: [{ name: 'a' }] }).valid).toBe(false);
    });
  });

  describe('元组类型', () => {
    it('固定长度元组按位置校验', () => {
      const validate = makeValidator(`export interface Q { pair: [string, number]; }`, 'Q');
      expect(validate({ pair: ['a', 1] }).valid).toBe(true);
      // 位置反了
      expect(validate({ pair: [1, 'a'] }).valid).toBe(false);
      // 长度不足
      expect(validate({ pair: ['a'] }).valid).toBe(false);
      // 长度超出
      expect(validate({ pair: ['a', 1, 2] }).valid).toBe(false);
      // 不是数组
      expect(validate({ pair: 'abc' }).valid).toBe(false);
    });

    it('可选元素元组', () => {
      const validate = makeValidator(`export interface Q { pair: [string, number?]; }`, 'Q');
      expect(validate({ pair: ['a', 1] }).valid).toBe(true);
      // 可选元素缺失
      expect(validate({ pair: ['a'] }).valid).toBe(true);
      // 长度超出
      expect(validate({ pair: ['a', 1, 2] }).valid).toBe(false);
      // 位置类型错误
      expect(validate({ pair: [1] }).valid).toBe(false);
    });

    it('剩余元素元组', () => {
      const validate = makeValidator(`export interface Q { list: [string, ...number[]]; }`, 'Q');
      expect(validate({ list: ['a'] }).valid).toBe(true);
      expect(validate({ list: ['a', 1, 2, 3] }).valid).toBe(true);
      // rest 元素类型错误
      expect(validate({ list: ['a', 'b'] }).valid).toBe(false);
      // 第一个元素类型错误
      expect(validate({ list: [1] }).valid).toBe(false);
    });

    it('命名元组成员', () => {
      const validate = makeValidator(
        `export interface Q { pair: [name: string, age: number]; }`,
        'Q',
      );
      expect(validate({ pair: ['alice', 18] }).valid).toBe(true);
      expect(validate({ pair: ['alice', '18'] }).valid).toBe(false);
    });

    it('多层嵌套元组', () => {
      const validate = makeValidator(
        `export interface Q { matrix: [[number, number], [number, number]]; }`,
        'Q',
      );
      expect(
        validate({
          matrix: [
            [1, 2],
            [3, 4],
          ],
        }).valid,
      ).toBe(true);
      expect(validate({ matrix: [[1, 2], [3]] }).valid).toBe(false);
      expect(
        validate({
          matrix: [
            [1, '2'],
            [3, 4],
          ],
        }).valid,
      ).toBe(false);
    });
  });

  describe('联合类型', () => {
    it('string | null', () => {
      const validate = makeValidator(`export interface Q { name: string | null; }`, 'Q');
      expect(validate({ name: 'foo' }).valid).toBe(true);
      expect(validate({ name: null }).valid).toBe(true);
      expect(validate({ name: 123 }).valid).toBe(false);
    });

    it('字面量联合校验失败的 expected 字段含具体值', () => {
      const validate = makeValidator(`export interface Q { role: 'admin' | 'user'; }`, 'Q');
      const r = validate({ role: 'guest' });
      expect(r.valid).toBe(false);
      expect(r.issues[0].expected).toBe("'admin' | 'user'");
      expect(r.issues[0].received).toBe('string');
    });

    it('基础类型联合校验失败的 expected 字段含类型名', () => {
      const validate = makeValidator(`export interface Q { name: string | null; }`, 'Q');
      const r = validate({ name: 123 });
      expect(r.valid).toBe(false);
      expect(r.issues[0].expected).toBe('string | null');
    });

    it('混合联合校验失败的 expected 字段', () => {
      const validate = makeValidator(`export interface Q { v: 'admin' | 200 | true; }`, 'Q');
      const r = validate({ v: 'guest' });
      expect(r.valid).toBe(false);
      expect(r.issues[0].expected).toBe("'admin' | 200 | true");
    });
  });

  describe('Date 类型', () => {
    it('Date 实例通过', () => {
      const validate = makeValidator(`export interface Q { createdAt: Date; }`, 'Q');
      expect(validate({ createdAt: new Date() }).valid).toBe(true);
    });

    it('合法 ISO 8601 字符串通过', () => {
      const validate = makeValidator(`export interface Q { createdAt: Date; }`, 'Q');
      expect(validate({ createdAt: '2024-01-01' }).valid).toBe(true);
      expect(validate({ createdAt: '2024-01-01T00:00:00Z' }).valid).toBe(true);
      expect(validate({ createdAt: '2024-01-01T00:00:00.000Z' }).valid).toBe(true);
      expect(validate({ createdAt: '2024-01-01T00:00:00+08:00' }).valid).toBe(true);
      expect(validate({ createdAt: '2024-01-01T00:00:00' }).valid).toBe(true);
    });

    it('非 ISO 格式字符串报 INVALID_FORMAT', () => {
      const validate = makeValidator(`export interface Q { createdAt: Date; }`, 'Q');
      // 非 ISO 格式
      const r1 = validate({ createdAt: 'not a date' });
      expect(r1.valid).toBe(false);
      expect(r1.issues[0].code).toBe('INVALID_FORMAT');
      // 月/日超出范围
      const r2 = validate({ createdAt: '2024-13-01' });
      expect(r2.valid).toBe(false);
      expect(r2.issues[0].code).toBe('INVALID_FORMAT');
      // 非 ISO 分隔符
      const r3 = validate({ createdAt: '01/01/2024' });
      expect(r3.valid).toBe(false);
      expect(r3.issues[0].code).toBe('INVALID_FORMAT');
    });

    it('非 string/Date 类型报 TYPE_MISMATCH', () => {
      const validate = makeValidator(`export interface Q { createdAt: Date; }`, 'Q');
      const r1 = validate({ createdAt: 123 });
      expect(r1.valid).toBe(false);
      expect(r1.issues[0].code).toBe('TYPE_MISMATCH');
      const r2 = validate({ createdAt: true });
      expect(r2.valid).toBe(false);
      expect(r2.issues[0].code).toBe('TYPE_MISMATCH');
    });
  });

  describe('Record 类型', () => {
    it('Record<string, number>', () => {
      const validate = makeValidator(`export interface Q { scores: Record<string, number>; }`, 'Q');
      expect(validate({ scores: { a: 1, b: 2 } }).valid).toBe(true);
      expect(validate({ scores: { a: '1' } }).valid).toBe(false);
    });
  });

  describe('unknown 类型', () => {
    it('unknown 不校验', () => {
      const validate = makeValidator(`export interface Q { data: unknown; name: string; }`, 'Q');
      expect(validate({ data: 'anything', name: 'foo' }).valid).toBe(true);
      expect(validate({ data: 123, name: 'foo' }).valid).toBe(true);
      expect(validate({ data: null, name: 'foo' }).valid).toBe(true);
    });
  });

  describe('嵌套对象', () => {
    it('多层嵌套', () => {
      const validate = makeValidator(
        `export interface Q {
          user: {
            name: string;
            address: {
              city: string;
              zip?: string;
            };
          };
        }`,
        'Q',
      );
      expect(validate({ user: { name: 'a', address: { city: 'BJ' } } }).valid).toBe(true);
      expect(validate({ user: { name: 'a', address: { city: 123 } } }).valid).toBe(false);
      expect(validate({ user: { name: 'a', address: {} } }).valid).toBe(false);
    });
  });

  describe('循环引用', () => {
    it('自引用类型支持递归校验', () => {
      const validate = makeValidator(
        `export interface TreeNode {
          value: number;
          children: TreeNode[];
          parent?: TreeNode;
        }`,
        'TreeNode',
      );
      // 单节点
      expect(validate({ value: 1, children: [] }).valid).toBe(true);
      // 带子节点
      expect(validate({ value: 1, children: [{ value: 2, children: [] }] }).valid).toBe(true);
      // 子节点类型错误
      expect(validate({ value: 1, children: [{ value: '2', children: [] }] }).valid).toBe(false);
      // 带 parent 的循环引用
      const node = { value: 1, children: [] } as any;
      node.parent = node; // 自引用
      expect(validate(node).valid).toBe(true);
    });

    it('互相引用的两个类型', () => {
      // A 引用 B，B 引用 A
      const validate = makeValidator(
        `export interface A { name: string; b?: B; }
export interface B { id: number; a?: A; }`,
        'A',
      );
      const a = { name: 'a' } as any;
      const b = { id: 1 } as any;
      a.b = b;
      b.a = a; // 循环
      expect(validate(a).valid).toBe(true);
      expect(validate({ name: 'a', b: { id: '1' } }).valid).toBe(false);
    });

    it('必填直接循环引用抛错', () => {
      // next: LinkedList 是必填直接 ref，无法自然终止
      expect(() =>
        makeValidator(
          `export interface LinkedList {
            value: number;
            next: LinkedList;
          }`,
          'LinkedList',
        ),
      ).toThrow(/必填.*循环引用|循环引用.*必填/);
    });

    it('互相必填引用抛错', () => {
      // A.b: B 必填，B.a: A 必填，互相无法终止
      expect(() =>
        makeValidator(
          `export interface A { b: B; }
export interface B { a: A; }`,
          'A',
        ),
      ).toThrow(/必填.*循环引用|循环引用.*必填/);
    });

    it('必填 ref 在联合类型中合法（有 null 终止）', () => {
      // next: LinkedList | null，值可以是 null，能终止
      expect(() =>
        makeValidator(
          `export interface LinkedList {
            value: number;
            next: LinkedList | null;
          }`,
          'LinkedList',
        ),
      ).not.toThrow();
    });

    it('匿名对象中的必填 ref 抛错', () => {
      // meta.next 是必填 ref
      expect(() =>
        makeValidator(
          `export interface TreeNode {
            value: number;
            meta: { next: TreeNode };
          }`,
          'TreeNode',
        ),
      ).toThrow(/必填.*循环引用|循环引用.*必填/);
    });
  });
});

describe('generateSchemaModule', () => {
  it('生成完整 JS 模块，包含多个 validator', () => {
    const dir = join(tmpdir(), `faapi-mod-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    const file1 = join(dir, 'user.ts');
    const file2 = join(dir, 'post.ts');
    writeFileSync(file1, `export interface GETQuery { id: number; }`);
    writeFileSync(file2, `export interface POSTBody { title: string; }`);

    const program1 = createProgram(file1);
    const program2 = createProgram(file2);
    const allTypes1 = extractAllTypes(program1, file1);
    const allTypes2 = extractAllTypes(program2, file2);
    const entries: SchemaModuleEntry[] = [
      {
        filePath: 'api/user/handler.ts',
        schemaName: 'GETQuery',
        typeInfo: allTypes1.get('GETQuery')!,
      },
      {
        filePath: 'api/post/handler.ts',
        schemaName: 'POSTBody',
        typeInfo: allTypes2.get('POSTBody')!,
      },
    ];

    const moduleSource = generateSchemaModule(entries);
    expect(moduleSource).toContain('validators');
    expect(moduleSource).toContain('api/user/handler.ts#GETQuery');
    expect(moduleSource).toContain('api/post/handler.ts#POSTBody');

    // 去掉 export 关键字，用 new Function 执行
    const execSource = moduleSource.replace(
      'export { validators, properties };',
      'return validators;',
    );
    const fn = new Function(execSource) as () => Record<
      string,
      (input: unknown) => ValidationResult
    >;
    const validators = fn();

    expect(validators['api/user/handler.ts#GETQuery']({ id: 1 }).valid).toBe(true);
    expect(validators['api/user/handler.ts#GETQuery']({ id: '1' }).valid).toBe(false);
    expect(validators['api/post/handler.ts#POSTBody']({ title: 'hello' }).valid).toBe(true);
    expect(validators['api/post/handler.ts#POSTBody']({ title: 123 }).valid).toBe(false);

    rmSync(dir, { recursive: true, force: true });
  });

  it('无类型声明的 handler 导出 null', () => {
    const entries: SchemaModuleEntry[] = [
      {
        filePath: 'api/health/handler.ts',
        schemaName: 'GETQuery',
        typeInfo: null,
      },
    ];
    const moduleSource = generateSchemaModule(entries);
    expect(moduleSource).toContain('null');
  });
});
