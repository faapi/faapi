import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProgram } from './createProgram';
import { extractAllTypes } from './extractHandlerTypes';
import {
  generateZodSchemaSource,
  generateHelpersFileSource,
  type TypeResolver,
} from './generateZodSchema';

/**
 * 从 TypeScript 源码提取类型信息并生成 zod schema 代码
 *
 * 流程：写源码到临时文件 → createProgram → extractAllTypes → generateZodSchemaSource
 *
 * @param coerce 透传给 generateZodSchemaSource 的第 4 个参数（query/params 场景为 true）
 */
function makeZodSchema(source: string, typeName: string, coerce = false): string {
  const dir = join(tmpdir(), `faapi-zod-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'test.ts');
  writeFileSync(file, source);
  const program = createProgram(file);
  const allTypes = extractAllTypes(program, file);
  const info = allTypes.get(typeName);
  if (!info) throw new Error(`类型 ${typeName} 未找到`);
  const resolveType: TypeResolver = (name: string) => allTypes.get(name)?.runtimeType;
  const sourceCode = generateZodSchemaSource(info, resolveType, undefined, coerce);
  rmSync(dir, { recursive: true, force: true });
  return sourceCode;
}

/**
 * 生成 zod schema 代码并执行，返回 zod schema 对象
 *
 * @param coerce 透传给 generateZodSchemaSource 的第 4 个参数（query/params 场景为 true）
 */
function makeZodSchemaObject(source: string, typeName: string, coerce = false) {
  const code = makeZodSchema(source, typeName, coerce);
  // 用 new Function 执行生成的代码，拿到 schema 对象
  // 替换 export const 为 const，去掉 import（注入 z）
  const execCode = code
    .replace(/^import.*$/gm, '')
    .replace(/export const/g, 'const')
    .replace(/: z\.ZodType<[^>]+>/g, '');
  // coerce 模式下，生成的代码引用了 coerceNumber / coerceBoolean 公用变量
  // 需要注入这两个函数的声明（模拟 faapi-helpers.js 的内容，但用 const 而非 export const）
  const helpers = coerce
    ? `${generateHelpersFileSource()
        .replace(/^\/\/.*$/gm, '')
        .replace(/export const/g, 'const')
        .trim()}\n`
    : '';
  const fn = new Function('z', `${helpers}${execCode}\nreturn ${typeName}Schema;`);
  // 动态 import zod
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const z = require('zod');
  return fn(z);
}

describe('generateZodSchema', () => {
  describe('基础类型', () => {
    it('string 类型', () => {
      const schema = makeZodSchemaObject(`export interface Q { name: string; }`, 'Q');
      expect(schema.safeParse({ name: 'foo' }).success).toBe(true);
      expect(schema.safeParse({ name: 123 }).success).toBe(false);
      expect(schema.safeParse({}).success).toBe(false); // 缺少必填
    });

    it('number 类型', () => {
      const schema = makeZodSchemaObject(`export interface Q { age: number; }`, 'Q');
      expect(schema.safeParse({ age: 18 }).success).toBe(true);
      expect(schema.safeParse({ age: '18' }).success).toBe(false);
      expect(schema.safeParse({ age: NaN }).success).toBe(false);
    });

    it('boolean 类型', () => {
      const schema = makeZodSchemaObject(`export interface Q { active: boolean; }`, 'Q');
      expect(schema.safeParse({ active: true }).success).toBe(true);
      expect(schema.safeParse({ active: 'true' }).success).toBe(false);
    });
  });

  describe('可选字段', () => {
    it('可选字段缺失时通过', () => {
      const schema = makeZodSchemaObject(`export interface Q { name: string; age?: number; }`, 'Q');
      expect(schema.safeParse({ name: 'foo' }).success).toBe(true);
      expect(schema.safeParse({ name: 'foo', age: 18 }).success).toBe(true);
      expect(schema.safeParse({ name: 'foo', age: '18' }).success).toBe(false);
    });

    it('string | null 传 null 通过', () => {
      const schema = makeZodSchemaObject(`export interface Q { name: string | null; }`, 'Q');
      expect(schema.safeParse({ name: null }).success).toBe(true);
      expect(schema.safeParse({ name: 'foo' }).success).toBe(true);
      expect(schema.safeParse({ name: 123 }).success).toBe(false);
    });

    it('可选字段显式声明 string | null,缺失时也通过', () => {
      const schema = makeZodSchemaObject(`export interface Q { name?: string | null; }`, 'Q');
      expect(schema.safeParse({}).success).toBe(true);
      expect(schema.safeParse({ name: null }).success).toBe(true);
      expect(schema.safeParse({ name: 'foo' }).success).toBe(true);
    });
  });

  describe('字面量类型', () => {
    it('字符串字面量', () => {
      const schema = makeZodSchemaObject(`export interface Q { role: 'admin' | 'user'; }`, 'Q');
      expect(schema.safeParse({ role: 'admin' }).success).toBe(true);
      expect(schema.safeParse({ role: 'user' }).success).toBe(true);
      expect(schema.safeParse({ role: 'guest' }).success).toBe(false);
    });

    it('数字字面量', () => {
      const schema = makeZodSchemaObject(`export interface Q { code: 200 | 404; }`, 'Q');
      expect(schema.safeParse({ code: 200 }).success).toBe(true);
      expect(schema.safeParse({ code: 500 }).success).toBe(false);
    });

    it('布尔字面量', () => {
      const schema = makeZodSchemaObject(`export interface Q { flag: true; }`, 'Q');
      expect(schema.safeParse({ flag: true }).success).toBe(true);
      expect(schema.safeParse({ flag: false }).success).toBe(false);
    });
  });

  describe('enum 类型', () => {
    it('字符串枚举', () => {
      const schema = makeZodSchemaObject(
        `enum Role { Admin = 'admin', User = 'user' }\nexport interface Q { role: Role; }`,
        'Q',
      );
      expect(schema.safeParse({ role: 'admin' }).success).toBe(true);
      expect(schema.safeParse({ role: 'user' }).success).toBe(true);
      expect(schema.safeParse({ role: 'guest' }).success).toBe(false);
    });

    it('数值枚举', () => {
      const schema = makeZodSchemaObject(
        `enum Code { OK = 200, NotFound = 404 }\nexport interface Q { code: Code; }`,
        'Q',
      );
      expect(schema.safeParse({ code: 200 }).success).toBe(true);
      expect(schema.safeParse({ code: 404 }).success).toBe(true);
      expect(schema.safeParse({ code: 500 }).success).toBe(false);
    });

    it('隐式数值枚举', () => {
      const schema = makeZodSchemaObject(
        `enum Dir { Up, Down, Left, Right }\nexport interface Q { dir: Dir; }`,
        'Q',
      );
      expect(schema.safeParse({ dir: 0 }).success).toBe(true);
      expect(schema.safeParse({ dir: 3 }).success).toBe(true);
      expect(schema.safeParse({ dir: 4 }).success).toBe(false);
    });
  });

  describe('数组类型', () => {
    it('string 数组', () => {
      const schema = makeZodSchemaObject(`export interface Q { tags: string[]; }`, 'Q');
      expect(schema.safeParse({ tags: ['a', 'b'] }).success).toBe(true);
      expect(schema.safeParse({ tags: 'a' }).success).toBe(false);
      expect(schema.safeParse({ tags: [1] }).success).toBe(false);
    });

    it('嵌套对象数组', () => {
      const schema = makeZodSchemaObject(
        `export interface Q { items: Array<{ id: number }>; }`,
        'Q',
      );
      expect(schema.safeParse({ items: [{ id: 1 }, { id: 2 }] }).success).toBe(true);
      expect(schema.safeParse({ items: [{ id: '1' }] }).success).toBe(false);
    });
  });

  describe('元组类型', () => {
    it('固定长度元组', () => {
      const schema = makeZodSchemaObject(`export interface Q { pair: [string, number]; }`, 'Q');
      expect(schema.safeParse({ pair: ['a', 1] }).success).toBe(true);
      expect(schema.safeParse({ pair: [1, 'a'] }).success).toBe(false);
      expect(schema.safeParse({ pair: ['a'] }).success).toBe(false);
      expect(schema.safeParse({ pair: ['a', 1, 2] }).success).toBe(false);
    });

    it('可选元素元组', () => {
      const schema = makeZodSchemaObject(`export interface Q { pair: [string, number?]; }`, 'Q');
      expect(schema.safeParse({ pair: ['a', 1] }).success).toBe(true);
      expect(schema.safeParse({ pair: ['a'] }).success).toBe(true);
      expect(schema.safeParse({ pair: ['a', 1, 2] }).success).toBe(false);
    });

    it('剩余元素元组', () => {
      const schema = makeZodSchemaObject(
        `export interface Q { list: [string, ...number[]]; }`,
        'Q',
      );
      expect(schema.safeParse({ list: ['a'] }).success).toBe(true);
      expect(schema.safeParse({ list: ['a', 1, 2, 3] }).success).toBe(true);
      expect(schema.safeParse({ list: ['a', 'b'] }).success).toBe(false);
    });
  });

  describe('联合类型', () => {
    it('string | null', () => {
      const schema = makeZodSchemaObject(`export interface Q { name: string | null; }`, 'Q');
      expect(schema.safeParse({ name: 'foo' }).success).toBe(true);
      expect(schema.safeParse({ name: null }).success).toBe(true);
      expect(schema.safeParse({ name: 123 }).success).toBe(false);
    });

    it('字面量联合', () => {
      const schema = makeZodSchemaObject(`export interface Q { role: 'admin' | 'user'; }`, 'Q');
      expect(schema.safeParse({ role: 'admin' }).success).toBe(true);
      expect(schema.safeParse({ role: 'guest' }).success).toBe(false);
    });
  });

  describe('Date 类型', () => {
    it('Date 实例通过', () => {
      const schema = makeZodSchemaObject(`export interface Q { createdAt: Date; }`, 'Q');
      expect(schema.safeParse({ createdAt: new Date() }).success).toBe(true);
    });

    it('合法 ISO 8601 字符串通过（z.coerce.date）', () => {
      const schema = makeZodSchemaObject(`export interface Q { createdAt: Date; }`, 'Q');
      expect(schema.safeParse({ createdAt: '2024-01-01' }).success).toBe(true);
      expect(schema.safeParse({ createdAt: '2024-01-01T00:00:00Z' }).success).toBe(true);
    });

    it('非 ISO 格式字符串不通过', () => {
      const schema = makeZodSchemaObject(`export interface Q { createdAt: Date; }`, 'Q');
      expect(schema.safeParse({ createdAt: 'not a date' }).success).toBe(false);
    });

    it('非 string/Date 类型不通过', () => {
      const schema = makeZodSchemaObject(`export interface Q { createdAt: Date; }`, 'Q');
      expect(schema.safeParse({ createdAt: 123 }).success).toBe(false);
      expect(schema.safeParse({ createdAt: true }).success).toBe(false);
    });
  });

  describe('Record 类型', () => {
    it('Record<string, number>', () => {
      const schema = makeZodSchemaObject(
        `export interface Q { scores: Record<string, number>; }`,
        'Q',
      );
      expect(schema.safeParse({ scores: { a: 1, b: 2 } }).success).toBe(true);
      expect(schema.safeParse({ scores: { a: '1' } }).success).toBe(false);
    });
  });

  describe('unknown 类型', () => {
    it('unknown 不校验', () => {
      const schema = makeZodSchemaObject(
        `export interface Q { data: unknown; name: string; }`,
        'Q',
      );
      expect(schema.safeParse({ data: 'anything', name: 'foo' }).success).toBe(true);
      expect(schema.safeParse({ data: 123, name: 'foo' }).success).toBe(true);
      expect(schema.safeParse({ data: null, name: 'foo' }).success).toBe(true);
    });
  });

  describe('嵌套对象', () => {
    it('多层嵌套', () => {
      const schema = makeZodSchemaObject(
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
      expect(
        schema.safeParse({
          user: { name: 'alice', address: { city: 'NYC' } },
        }).success,
      ).toBe(true);
      expect(
        schema.safeParse({
          user: { name: 'alice', address: { city: 'NYC', zip: '10001' } },
        }).success,
      ).toBe(true);
      expect(
        schema.safeParse({
          user: { name: 'alice', address: {} },
        }).success,
      ).toBe(false);
    });
  });

  describe('命名类型引用', () => {
    it('引用同文件 interface', () => {
      const schema = makeZodSchemaObject(
        `export interface Address { city: string; }
         export interface Q { address: Address; }`,
        'Q',
      );
      expect(schema.safeParse({ address: { city: 'NYC' } }).success).toBe(true);
      expect(schema.safeParse({ address: {} }).success).toBe(false);
    });

    it('循环引用（TreeNode）', () => {
      const schema = makeZodSchemaObject(
        `export interface TreeNode {
          value: number;
          children?: TreeNode[];
        }`,
        'TreeNode',
      );
      expect(schema.safeParse({ value: 1 }).success).toBe(true);
      expect(
        schema.safeParse({
          value: 1,
          children: [{ value: 2 }, { value: 3, children: [{ value: 4 }] }],
        }).success,
      ).toBe(true);
      expect(schema.safeParse({ value: '1' }).success).toBe(false);
    });

    it('互相引用（A 引用 B，B 引用 A）', () => {
      const schemaA = makeZodSchemaObject(
        `export interface B { id: number; }
         export interface A { b: B; }`,
        'A',
      );
      expect(schemaA.safeParse({ b: { id: 1 } }).success).toBe(true);
      expect(schemaA.safeParse({ b: { id: '1' } }).success).toBe(false);
    });
  });

  describe('生成代码格式', () => {
    it('生成 import 语句', () => {
      const code = makeZodSchema(`export interface Q { name: string; }`, 'Q');
      expect(code).toContain("import { z } from 'zod'");
    });

    it('生成 export const Schema', () => {
      const code = makeZodSchema(`export interface Q { name: string; }`, 'Q');
      expect(code).toContain('export const QSchema');
    });

    it('可选字段用 .optional()', () => {
      const code = makeZodSchema(`export interface Q { name?: string; }`, 'Q');
      expect(code).toContain('z.string().optional()');
    });

    it('循环引用用 z.lazy', () => {
      const code = makeZodSchema(
        `export interface TreeNode {
          value: number;
          children?: TreeNode[];
        }`,
        'TreeNode',
      );
      expect(code).toContain('z.lazy');
    });

    it('exportName 与 typeInfo.name 不同时，循环引用自引用指向 exportName', () => {
      // 模拟 WS handler 的场景：类型名是 TreeNode，但 schemaName 是 WSTreeNode
      // zod.js 导出 WSTreeNodeSchema，自引用也必须指向 WSTreeNodeSchema
      const dir = join(tmpdir(), `faapi-zod-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, 'test.ts');
      writeFileSync(
        file,
        `export interface TreeNode {
          value: number;
          children?: TreeNode[];
        }`,
      );
      const program = createProgram(file);
      const allTypes = extractAllTypes(program, file);
      const info = allTypes.get('TreeNode')!;
      const resolveType: TypeResolver = (name: string) => allTypes.get(name)?.runtimeType;
      const code = generateZodSchemaSource(info, resolveType, 'WSTreeNode');
      rmSync(dir, { recursive: true, force: true });

      // 导出名是 WSTreeNodeSchema
      expect(code).toContain('export const WSTreeNodeSchema');
      // 自引用必须指向 WSTreeNodeSchema，而不是未定义的 TreeNodeSchema
      expect(code).toContain('z.array(WSTreeNodeSchema)');
      // 不应出现独立的 TreeNodeSchema 引用（无 WS 前缀，即 bug 时的 z.array(TreeNodeSchema)）
      expect(code).not.toContain('z.array(TreeNodeSchema)');
      expect(code).not.toContain('const TreeNodeSchema');

      // 验证生成的 schema 能正确校验循环引用数据
      const execCode = code.replace(/^import.*$/gm, '').replace(/export const/g, 'const');
      const fn = new Function('z', `${execCode}\nreturn WSTreeNodeSchema;`);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const z = require('zod');
      const schema = fn(z);
      expect(schema.safeParse({ value: 1 }).success).toBe(true);
      expect(
        schema.safeParse({
          value: 1,
          children: [{ value: 2, children: [{ value: 3 }] }],
        }).success,
      ).toBe(true);
      expect(schema.safeParse({ value: '1' }).success).toBe(false);
    });
  });

  describe('coerce 模式', () => {
    describe('coerce=true 时 number 字段包 preprocess', () => {
      it('生成代码包含 z.preprocess 包裹 z.number()', () => {
        const code = makeZodSchema(`export interface Q { page: number; }`, 'Q', true);
        expect(code).toContain('z.preprocess');
        expect(code).toContain('z.number()');
        // preprocess 应在 z.number() 外层包裹
        expect(code).toMatch(/z\.preprocess\([^]*z\.number\(\)/);
      });

      it('schema 对象能 coerce: "1" → 1 校验通过', () => {
        const schema = makeZodSchemaObject(`export interface Q { page: number; }`, 'Q', true);
        const r = schema.safeParse({ page: '1' });
        expect(r.success).toBe(true);
        if (r.success) expect(r.data.page).toBe(1);
        // number 原值也通过
        expect(schema.safeParse({ page: 1 }).success).toBe(true);
      });

      it('空字符串 "" 不 coerce（Number("") = 0 陷阱），保留原值后 zod 报 invalid_type', () => {
        const schema = makeZodSchemaObject(`export interface Q { page: number; }`, 'Q', true);
        const r = schema.safeParse({ page: '' });
        expect(r.success).toBe(false);
      });

      it('非数字 "abc" 不 coerce，保留原值后 zod 报 invalid_type', () => {
        const schema = makeZodSchemaObject(`export interface Q { page: number; }`, 'Q', true);
        const r = schema.safeParse({ page: 'abc' });
        expect(r.success).toBe(false);
      });
    });

    describe('coerce=true 时 boolean 字段包 preprocess', () => {
      it('"true"/"1" → true, "false"/"0" → false 校验通过', () => {
        const schema = makeZodSchemaObject(`export interface Q { active: boolean; }`, 'Q', true);
        expect(schema.safeParse({ active: 'true' }).success).toBe(true);
        expect(schema.safeParse({ active: '1' }).success).toBe(true);
        expect(schema.safeParse({ active: 'false' }).success).toBe(true);
        expect(schema.safeParse({ active: '0' }).success).toBe(true);
        // boolean 原值也通过
        expect(schema.safeParse({ active: true }).success).toBe(true);
        expect(schema.safeParse({ active: false }).success).toBe(true);
      });

      it('其他字符串如 "yes" 不 coerce，zod 报 invalid_type', () => {
        const schema = makeZodSchemaObject(`export interface Q { active: boolean; }`, 'Q', true);
        expect(schema.safeParse({ active: 'yes' }).success).toBe(false);
        expect(schema.safeParse({ active: 'maybe' }).success).toBe(false);
      });
    });

    describe('coerce=false 时无 preprocess（默认行为）', () => {
      it('生成代码不包含 z.preprocess', () => {
        const code = makeZodSchema(`export interface Q { page: number; active: boolean; }`, 'Q');
        expect(code).not.toContain('z.preprocess');
      });

      it('schema 对 "1" 直接报 invalid_type（不 coerce）', () => {
        const schema = makeZodSchemaObject(
          `export interface Q { page: number; active: boolean; }`,
          'Q',
        );
        expect(schema.safeParse({ page: '1', active: true }).success).toBe(false);
        expect(schema.safeParse({ page: 1, active: 'true' }).success).toBe(false);
      });
    });

    describe('嵌套类型递归 coerce', () => {
      it('tags?: string[] 不影响（array of string 不需要 coerce）', () => {
        const code = makeZodSchema(`export interface Q { tags?: string[]; }`, 'Q', true);
        // string 元素不应被 preprocess 包裹
        expect(code).not.toContain('z.preprocess');
        const schema = makeZodSchemaObject(`export interface Q { tags?: string[]; }`, 'Q', true);
        expect(schema.safeParse({ tags: ['a', 'b'] }).success).toBe(true);
        expect(schema.safeParse({}).success).toBe(true);
      });

      it('counts: number[] 中元素 number 被 coerce: ["1", "2"] → [1, 2]', () => {
        const code = makeZodSchema(`export interface Q { counts: number[]; }`, 'Q', true);
        expect(code).toContain('z.preprocess');
        expect(code).toMatch(/z\.array\(z\.preprocess[^]*z\.number\(\)\)/);
        const schema = makeZodSchemaObject(`export interface Q { counts: number[]; }`, 'Q', true);
        const r = schema.safeParse({ counts: ['1', '2'] });
        expect(r.success).toBe(true);
        if (r.success) expect(r.data.counts).toEqual([1, 2]);
        // number 原值数组也通过
        expect(schema.safeParse({ counts: [1, 2] }).success).toBe(true);
      });

      it('嵌套对象 { meta: { count: number } } 中 count 被 coerce', () => {
        const code = makeZodSchema(`export interface Q { meta: { count: number; }; }`, 'Q', true);
        expect(code).toContain('z.preprocess');
        const schema = makeZodSchemaObject(
          `export interface Q { meta: { count: number; }; }`,
          'Q',
          true,
        );
        const r = schema.safeParse({ meta: { count: '5' } });
        expect(r.success).toBe(true);
        if (r.success) expect(r.data.meta.count).toBe(5);
      });
    });
  });
});
