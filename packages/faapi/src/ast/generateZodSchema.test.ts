import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProgram } from './createProgram';
import { extractAllTypes } from './extractHandlerTypes';
import {
  generateZodSchemaSource,
  generateHelpersFileSource,
  usesCoerceHelpers,
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
  // 生成的代码可能引用 coerceNumber / coerceBoolean / coerceMap / coerceSet 公用变量
  // 检测代码是否引用任意 helper，引用则注入全部声明（模拟 faapi-helpers.js，但用 const 而非 export const）
  // 注意：Map/Set 在 coerce=false（body 场景）下也会引用 coerceMap/coerceSet，故不能仅靠 coerce 标志判断
  const needsHelpers = coerce || usesCoerceHelpers(execCode);
  const helpers = needsHelpers
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

  describe('JSDoc 约束标签', () => {
    describe('数值约束', () => {
      it('@max @min 生成链式调用并校验', () => {
        const schema = makeZodSchemaObject(
          `export interface Q {
            /** @min 1 @max 100 */
            page: number;
          }`,
          'Q',
        );
        expect(schema.safeParse({ page: 50 }).success).toBe(true);
        expect(schema.safeParse({ page: 0 }).success).toBe(false);
        expect(schema.safeParse({ page: 101 }).success).toBe(false);
      });

      it('@int 校验整数', () => {
        const schema = makeZodSchemaObject(
          `export interface Q {
            /** @int */
            count: number;
          }`,
          'Q',
        );
        expect(schema.safeParse({ count: 5 }).success).toBe(true);
        expect(schema.safeParse({ count: 5.5 }).success).toBe(false);
      });

      it('@positive @negative 校验', () => {
        const schema = makeZodSchemaObject(
          `export interface Q {
            /** @positive */
            amount: number;
            /** @negative */
            debt: number;
          }`,
          'Q',
        );
        expect(schema.safeParse({ amount: 1, debt: -1 }).success).toBe(true);
        expect(schema.safeParse({ amount: 0, debt: -1 }).success).toBe(false);
        expect(schema.safeParse({ amount: 1, debt: 0 }).success).toBe(false);
      });

      it('@nonnegative @nonpositive 校验', () => {
        const schema = makeZodSchemaObject(
          `export interface Q {
            /** @nonnegative */
            a: number;
            /** @nonpositive */
            b: number;
          }`,
          'Q',
        );
        expect(schema.safeParse({ a: 0, b: 0 }).success).toBe(true);
        expect(schema.safeParse({ a: 1, b: -1 }).success).toBe(true);
        expect(schema.safeParse({ a: -1, b: -1 }).success).toBe(false);
        expect(schema.safeParse({ a: 1, b: 1 }).success).toBe(false);
      });
    });

    describe('长度约束', () => {
      it('string @minLength @maxLength 校验', () => {
        const schema = makeZodSchemaObject(
          `export interface Q {
            /** @minLength 3 @maxLength 5 */
            name: string;
          }`,
          'Q',
        );
        expect(schema.safeParse({ name: 'abc' }).success).toBe(true);
        expect(schema.safeParse({ name: 'abcde' }).success).toBe(true);
        expect(schema.safeParse({ name: 'ab' }).success).toBe(false);
        expect(schema.safeParse({ name: 'abcdef' }).success).toBe(false);
      });

      it('string @length 校验精确长度', () => {
        const schema = makeZodSchemaObject(
          `export interface Q {
            /** @length 4 */
            code: string;
          }`,
          'Q',
        );
        expect(schema.safeParse({ code: '1234' }).success).toBe(true);
        expect(schema.safeParse({ code: '123' }).success).toBe(false);
        expect(schema.safeParse({ code: '12345' }).success).toBe(false);
      });

      it('array @maxLength 校验数组长度', () => {
        const schema = makeZodSchemaObject(
          `export interface Q {
            /** @maxLength 3 */
            tags: string[];
          }`,
          'Q',
        );
        expect(schema.safeParse({ tags: ['a', 'b', 'c'] }).success).toBe(true);
        expect(schema.safeParse({ tags: ['a', 'b', 'c', 'd'] }).success).toBe(false);
      });
    });

    describe('字符串格式约束', () => {
      it('@regex 校验正则', () => {
        const schema = makeZodSchemaObject(
          `export interface Q {
            /** @regex /^[a-z]+$/i */
            slug: string;
          }`,
          'Q',
        );
        expect(schema.safeParse({ slug: 'hello' }).success).toBe(true);
        expect(schema.safeParse({ slug: 'HELLO' }).success).toBe(true);
        expect(schema.safeParse({ slug: 'hello123' }).success).toBe(false);
      });

      it('@email 校验邮箱', () => {
        const schema = makeZodSchemaObject(
          `export interface Q {
            /** @email */
            email: string;
          }`,
          'Q',
        );
        expect(schema.safeParse({ email: 'a@b.com' }).success).toBe(true);
        expect(schema.safeParse({ email: 'not-email' }).success).toBe(false);
      });

      it('@url 校验 URL', () => {
        const schema = makeZodSchemaObject(
          `export interface Q {
            /** @url */
            homepage: string;
          }`,
          'Q',
        );
        expect(schema.safeParse({ homepage: 'https://example.com' }).success).toBe(true);
        expect(schema.safeParse({ homepage: 'not-url' }).success).toBe(false);
      });

      it('@uuid 校验 UUID', () => {
        const schema = makeZodSchemaObject(
          `export interface Q {
            /** @uuid */
            id: string;
          }`,
          'Q',
        );
        expect(schema.safeParse({ id: '550e8400-e29b-41d4-a716-446655440000' }).success).toBe(true);
        expect(schema.safeParse({ id: 'not-uuid' }).success).toBe(false);
      });
    });

    describe('组合约束', () => {
      it('多约束叠加生成链式调用', () => {
        const code = makeZodSchema(
          `export interface Q {
            /** @min 0 @max 100 @int */
            score: number;
          }`,
          'Q',
        );
        // 链式调用顺序与 JSDoc 标签顺序一致
        expect(code).toContain('z.number().min(0).max(100).int()');
      });

      it('可选字段约束链 + .optional()', () => {
        const code = makeZodSchema(
          `export interface Q {
            /** @max 100 */
            score?: number;
          }`,
          'Q',
        );
        // 约束链在 .optional() 之前
        expect(code).toContain('z.number().max(100).optional()');
      });

      it('生成代码实际校验组合约束', () => {
        const schema = makeZodSchemaObject(
          `export interface Q {
            /** @min 1 @max 100 @int */
            page: number;
          }`,
          'Q',
        );
        expect(schema.safeParse({ page: 50 }).success).toBe(true);
        expect(schema.safeParse({ page: 0 }).success).toBe(false);
        expect(schema.safeParse({ page: 101 }).success).toBe(false);
        expect(schema.safeParse({ page: 50.5 }).success).toBe(false);
      });
    });

    describe('coerce + 约束组合', () => {
      it('coerce 模式下约束作用于 z.number() 内层', () => {
        const code = makeZodSchema(
          `export interface Q {
            /** @min 1 @max 100 */
            page: number;
          }`,
          'Q',
          true,
        );
        // 约束应在 preprocess 内部的 z.number() 上
        expect(code).toMatch(/z\.preprocess\(coerceNumber, z\.number\(\)\.min\(1\)\.max\(100\)\)/);
      });

      it('coerce + 约束实际校验', () => {
        const schema = makeZodSchemaObject(
          `export interface Q {
            /** @min 1 @max 100 */
            page: number;
          }`,
          'Q',
          true,
        );
        expect(schema.safeParse({ page: '50' }).success).toBe(true);
        expect(schema.safeParse({ page: '0' }).success).toBe(false);
        expect(schema.safeParse({ page: '101' }).success).toBe(false);
      });
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

  describe('Map / Set 类型', () => {
    describe('代码生成', () => {
      it('Map<string, number> 生成 z.preprocess(coerceMap, z.map(z.string(), z.number()))', () => {
        const code = makeZodSchema(`export interface Q { data: Map<string, number>; }`, 'Q');
        expect(code).toMatch(/z\.preprocess\(coerceMap, z\.map\(z\.string\(\), z\.number\(\)\)\)/);
      });

      it('Set<string> 生成 z.preprocess(coerceSet, z.set(z.string()))', () => {
        const code = makeZodSchema(`export interface Q { data: Set<string>; }`, 'Q');
        expect(code).toMatch(/z\.preprocess\(coerceSet, z\.set\(z\.string\(\)\)\)/);
      });

      it('Map 嵌套数组：Map<string, number[]> 内部数组元素不被 coerce 包裹', () => {
        const code = makeZodSchema(`export interface Q { data: Map<string, number[]>; }`, 'Q');
        expect(code).toMatch(/z\.map\(z\.string\(\), z\.array\(z\.number\(\)\)\)/);
        // body 场景（coerce=false）下 number 元素不应有 coerceNumber 包裹
        expect(code).not.toContain('coerceNumber');
      });

      it('Set<User> 引用命名类型时内联为对象', () => {
        const code = makeZodSchema(
          `export interface User { id: number; name: string; }
           export interface Q { data: Set<User>; }`,
          'Q',
        );
        // User 被 checker 内联，应出现 z.set(z.object({
        expect(code).toContain('z.set(z.object({');
        expect(code).toMatch(/z\.preprocess\(coerceSet, /);
      });

      it('Map 嵌套 Set：Map<string, Set<number>>', () => {
        const code = makeZodSchema(`export interface Q { data: Map<string, Set<number>>; }`, 'Q');
        // 外层 coerceMap，内层 coerceSet
        expect(code).toMatch(
          /z\.preprocess\(coerceMap, z\.map\(z\.string\(\), z\.preprocess\(coerceSet, z\.set\(z\.number\(\)\)\)\)\)/,
        );
      });
    });

    describe('coerce=false（body 场景）实际校验', () => {
      it('Map<string, number> entries 数组通过校验并还原为 Map 实例', () => {
        const schema = makeZodSchemaObject(
          `export interface Q { data: Map<string, number>; }`,
          'Q',
        );
        const r = schema.safeParse({
          data: [
            ['a', 1],
            ['b', 2],
          ],
        });
        expect(r.success).toBe(true);
        if (r.success) {
          expect(r.data.data).toBeInstanceOf(Map);
          expect(r.data.data.get('a')).toBe(1);
          expect(r.data.data.get('b')).toBe(2);
        }
      });

      it('Map<string, number> 普通对象通过校验（Object.entries 还原）', () => {
        const schema = makeZodSchemaObject(
          `export interface Q { data: Map<string, number>; }`,
          'Q',
        );
        const r = schema.safeParse({ data: { a: 1, b: 2 } });
        expect(r.success).toBe(true);
        if (r.success) {
          expect(r.data.data).toBeInstanceOf(Map);
          expect(r.data.data.get('a')).toBe(1);
        }
      });

      it('Map<string, number> 已有 Map 实例直接通过', () => {
        const schema = makeZodSchemaObject(
          `export interface Q { data: Map<string, number>; }`,
          'Q',
        );
        const r = schema.safeParse({ data: new Map([['a', 1]]) });
        expect(r.success).toBe(true);
        if (r.success) expect(r.data.data.get('a')).toBe(1);
      });

      it('Map<string, number> value 类型不匹配时校验失败', () => {
        const schema = makeZodSchemaObject(
          `export interface Q { data: Map<string, number>; }`,
          'Q',
        );
        expect(schema.safeParse({ data: [['a', 'not-a-number']] }).success).toBe(false);
      });

      it('Map<string, number> key 类型不匹配时校验失败', () => {
        const schema = makeZodSchemaObject(
          `export interface Q { data: Map<string, number>; }`,
          'Q',
        );
        expect(schema.safeParse({ data: [[123, 1]] }).success).toBe(false);
      });

      it('Set<string> 数组通过校验并还原为 Set 实例', () => {
        const schema = makeZodSchemaObject(`export interface Q { data: Set<string>; }`, 'Q');
        const r = schema.safeParse({ data: ['a', 'b', 'c'] });
        expect(r.success).toBe(true);
        if (r.success) {
          expect(r.data.data).toBeInstanceOf(Set);
          expect(Array.from(r.data.data)).toEqual(['a', 'b', 'c']);
        }
      });

      it('Set<string> 已有 Set 实例直接通过', () => {
        const schema = makeZodSchemaObject(`export interface Q { data: Set<string>; }`, 'Q');
        const r = schema.safeParse({ data: new Set(['a', 'b']) });
        expect(r.success).toBe(true);
      });

      it('Set<string> 元素类型不匹配时校验失败', () => {
        const schema = makeZodSchemaObject(`export interface Q { data: Set<string>; }`, 'Q');
        expect(schema.safeParse({ data: ['a', 123] }).success).toBe(false);
      });

      it('Map<string, number[]> 嵌套数组校验', () => {
        const schema = makeZodSchemaObject(
          `export interface Q { data: Map<string, number[]>; }`,
          'Q',
        );
        const r = schema.safeParse({
          data: [
            ['a', [1, 2]],
            ['b', [3]],
          ],
        });
        expect(r.success).toBe(true);
        if (r.success) {
          expect(r.data.data.get('a')).toEqual([1, 2]);
          expect(r.data.data.get('b')).toEqual([3]);
        }
      });

      it('Set<User> 命名类型元素校验', () => {
        const schema = makeZodSchemaObject(
          `export interface User { id: number; name: string; }
           export interface Q { data: Set<User>; }`,
          'Q',
        );
        const r = schema.safeParse({
          data: [
            { id: 1, name: 'alice' },
            { id: 2, name: 'bob' },
          ],
        });
        expect(r.success).toBe(true);
        if (r.success) {
          expect(r.data.data).toBeInstanceOf(Set);
          expect(Array.from(r.data.data)).toHaveLength(2);
        }
      });

      it('Map 嵌套 Set：Map<string, Set<number>>', () => {
        const schema = makeZodSchemaObject(
          `export interface Q { data: Map<string, Set<number>>; }`,
          'Q',
        );
        const r = schema.safeParse({
          data: [
            ['a', [1, 2]],
            ['b', [3]],
          ],
        });
        expect(r.success).toBe(true);
        if (r.success) {
          expect(r.data.data.get('a')).toBeInstanceOf(Set);
          expect(Array.from(r.data.data.get('a'))).toEqual([1, 2]);
        }
      });

      it('Map/Set 字段非数组/对象/Map/Set 时校验失败', () => {
        const schema = makeZodSchemaObject(
          `export interface Q { m: Map<string, number>; s: Set<string>; }`,
          'Q',
        );
        // 字符串既不是数组也不是 Map/对象，coerceMap 原样返回，z.map 报错
        expect(schema.safeParse({ m: 'not-a-map', s: ['a'] }).success).toBe(false);
        expect(schema.safeParse({ m: [['a', 1]], s: 'not-a-set' }).success).toBe(false);
      });

      it('可选 Map/Set 字段缺失时通过', () => {
        const schema = makeZodSchemaObject(
          `export interface Q { m?: Map<string, number>; s?: Set<string>; }`,
          'Q',
        );
        expect(schema.safeParse({}).success).toBe(true);
      });
    });

    describe('coerce=true（query 场景）', () => {
      it('Map<string, number> 内部 number value 被 coerce：[["a","1"]] → [["a",1]]', () => {
        const schema = makeZodSchemaObject(
          `export interface Q { data: Map<string, number>; }`,
          'Q',
          true,
        );
        const r = schema.safeParse({
          data: [
            ['a', '1'],
            ['b', '2'],
          ],
        });
        expect(r.success).toBe(true);
        if (r.success) {
          expect(r.data.data.get('a')).toBe(1);
          expect(r.data.data.get('b')).toBe(2);
        }
      });

      it('Set<number> 元素 number 被 coerce：["1","2"] → [1,2]', () => {
        const schema = makeZodSchemaObject(`export interface Q { data: Set<number>; }`, 'Q', true);
        const r = schema.safeParse({ data: ['1', '2', '3'] });
        expect(r.success).toBe(true);
        if (r.success) {
          expect(Array.from(r.data.data)).toEqual([1, 2, 3]);
        }
      });

      it('coerce=true 时 Map 生成代码同时包含 coerceMap（外层）和 coerceNumber（内部）', () => {
        const code = makeZodSchema(`export interface Q { data: Map<string, number>; }`, 'Q', true);
        expect(code).toContain('coerceMap');
        expect(code).toContain('coerceNumber');
        // value 应为 z.preprocess(coerceNumber, z.number())
        expect(code).toMatch(
          /z\.preprocess\(coerceMap, z\.map\(z\.string\(\), z\.preprocess\(coerceNumber, z\.number\(\)\)\)\)/,
        );
      });
    });
  });
});
