import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProgram } from './createProgram';
import { extractTypeInfo } from './extractHandlerTypes';
import { SchemaExtractionError } from './resolveTypeNode';

describe('extractTypeInfo', () => {
  let tempDir: string;
  let tempFile: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `faapi-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    tempFile = join(tempDir, 'route.ts');

    writeFileSync(
      tempFile,
      `export interface GETQuery {
  page: number;
  pageSize: number;
  name?: string;
  active: boolean;
  data: unknown;
}

export interface POSTBody {
  title: string;
  count: number;
}
`,
    );
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('提取 GETQuery 的类型信息', () => {
    const program = createProgram(tempFile);
    const info = extractTypeInfo(program, tempFile, 'GETQuery');

    expect(info).not.toBeNull();
    expect(info!.name).toBe('GETQuery');
    expect(info!.properties).toHaveLength(5);
    expect(info!.runtimeType.kind).toBe('object');

    const page = info!.properties.find((p) => p.name === 'page');
    expect(page).toEqual({ name: 'page', type: { kind: 'number' }, optional: false });

    const pageSize = info!.properties.find((p) => p.name === 'pageSize');
    expect(pageSize).toEqual({ name: 'pageSize', type: { kind: 'number' }, optional: false });

    const name = info!.properties.find((p) => p.name === 'name');
    expect(name).toEqual({ name: 'name', type: { kind: 'string' }, optional: true });

    const active = info!.properties.find((p) => p.name === 'active');
    expect(active).toEqual({ name: 'active', type: { kind: 'boolean' }, optional: false });

    const data = info!.properties.find((p) => p.name === 'data');
    expect(data).toEqual({ name: 'data', type: { kind: 'any' }, optional: false });
  });

  it('提取 POSTBody 的类型信息', () => {
    const program = createProgram(tempFile);
    const info = extractTypeInfo(program, tempFile, 'POSTBody');

    expect(info).not.toBeNull();
    expect(info!.name).toBe('POSTBody');
    expect(info!.properties).toHaveLength(2);
    expect(info!.runtimeType.kind).toBe('object');

    const title = info!.properties.find((p) => p.name === 'title');
    expect(title).toEqual({ name: 'title', type: { kind: 'string' }, optional: false });

    const count = info!.properties.find((p) => p.name === 'count');
    expect(count).toEqual({ name: 'count', type: { kind: 'number' }, optional: false });
  });

  it('不存在的类型名返回 null', () => {
    const program = createProgram(tempFile);
    const info = extractTypeInfo(program, tempFile, 'NonExistent');
    expect(info).toBeNull();
  });

  describe('Pick / Omit 工具类型', () => {
    let pickFile: string;
    let omitFile: string;

    beforeEach(() => {
      pickFile = join(tempDir, 'pick.ts');
      writeFileSync(
        pickFile,
        `export interface User {
  id: number;
  name: string;
  email: string;
}
export type GETQuery = Pick<User, 'id' | 'name'>;
`,
      );

      omitFile = join(tempDir, 'omit.ts');
      writeFileSync(
        omitFile,
        `export interface User {
  id: number;
  name: string;
  email: string;
}
export type GETQuery = Omit<User, 'email'>;
`,
      );
    });

    it('Pick 解析为实际字段子集', () => {
      const program = createProgram(pickFile);
      const info = extractTypeInfo(program, pickFile, 'GETQuery');

      expect(info).not.toBeNull();
      expect(info!.runtimeType.kind).toBe('object');
      const props = info!.properties.map((p) => p.name);
      expect(props.sort()).toEqual(['id', 'name']);

      const id = info!.properties.find((p) => p.name === 'id');
      expect(id!.type).toEqual({ kind: 'number' });
      const name = info!.properties.find((p) => p.name === 'name');
      expect(name!.type).toEqual({ kind: 'string' });
    });

    it('Omit 解析为排除指定字段后的子集', () => {
      const program = createProgram(omitFile);
      const info = extractTypeInfo(program, omitFile, 'GETQuery');

      expect(info).not.toBeNull();
      expect(info!.runtimeType.kind).toBe('object');
      const props = info!.properties.map((p) => p.name);
      expect(props.sort()).toEqual(['id', 'name']);

      // 确认 email 被排除
      expect(info!.properties.find((p) => p.name === 'email')).toBeUndefined();
    });

    it('Pick 单个字段', () => {
      const file = join(tempDir, 'pick-single.ts');
      writeFileSync(
        file,
        `export interface User { id: number; name: string; }
export type GETQuery = Pick<User, 'name'>;
`,
      );
      const program = createProgram(file);
      const info = extractTypeInfo(program, file, 'GETQuery');

      expect(info).not.toBeNull();
      expect(info!.properties).toHaveLength(1);
      expect(info!.properties[0].name).toBe('name');
    });

    it('Pick 的 K 为类型别名时解析为实际字段', () => {
      const file = join(tempDir, 'pick-alias.ts');
      writeFileSync(
        file,
        `export interface User {
  id: number;
  name: string;
  email: string;
}
type UserKeys = 'id' | 'name';
export type GETQuery = Pick<User, UserKeys>;
`,
      );
      const program = createProgram(file);
      const info = extractTypeInfo(program, file, 'GETQuery');

      expect(info).not.toBeNull();
      expect(info!.runtimeType.kind).toBe('object');
      const props = info!.properties.map((p) => p.name);
      expect(props.sort()).toEqual(['id', 'name']);
      expect(info!.properties.find((p) => p.name === 'email')).toBeUndefined();
    });

    it('Pick 的 K 为 keyof T 时解析为全部字段', () => {
      const file = join(tempDir, 'pick-keyof.ts');
      writeFileSync(
        file,
        `export interface User {
  id: number;
  name: string;
  email: string;
}
export type GETQuery = Pick<User, keyof User>;
`,
      );
      const program = createProgram(file);
      const info = extractTypeInfo(program, file, 'GETQuery');

      expect(info).not.toBeNull();
      expect(info!.runtimeType.kind).toBe('object');
      const props = info!.properties.map((p) => p.name);
      expect(props.sort()).toEqual(['email', 'id', 'name']);
    });

    it('Omit 的 K 为 keyof T 时排除指定字段', () => {
      const file = join(tempDir, 'omit-keyof.ts');
      writeFileSync(
        file,
        `export interface User {
  id: number;
  name: string;
  email: string;
}
type OnlyEmail = 'email';
export type GETQuery = Omit<User, OnlyEmail>;
`,
      );
      const program = createProgram(file);
      const info = extractTypeInfo(program, file, 'GETQuery');

      expect(info).not.toBeNull();
      expect(info!.runtimeType.kind).toBe('object');
      const props = info!.properties.map((p) => p.name);
      expect(props.sort()).toEqual(['id', 'name']);
      expect(info!.properties.find((p) => p.name === 'email')).toBeUndefined();
    });
  });

  describe('readonly 修饰符（字段/数组/元组）', () => {
    let readonlyDir: string;

    beforeEach(() => {
      readonlyDir = join(tmpdir(), `faapi-readonly-${Date.now()}`);
      mkdirSync(readonlyDir, { recursive: true });
    });

    afterEach(() => {
      rmSync(readonlyDir, { recursive: true, force: true });
    });

    function extractFrom(content: string, typeName = 'GETQuery') {
      const file = join(readonlyDir, `${Date.now()}-${Math.random().toString(36).slice(2)}.ts`);
      writeFileSync(file, content);
      const program = createProgram(file);
      return () => extractTypeInfo(program, file, typeName);
    }

    it('readonly 字段修饰符：忽略修饰符，按底层类型解析', () => {
      const fn = extractFrom(
        `export interface GETQuery { readonly id: string; readonly count: number; name?: string; }`,
      );
      const info = fn();

      expect(info).not.toBeNull();
      const id = info!.properties.find((p) => p.name === 'id');
      expect(id).toEqual({ name: 'id', type: { kind: 'string' }, optional: false });
      const count = info!.properties.find((p) => p.name === 'count');
      expect(count).toEqual({ name: 'count', type: { kind: 'number' }, optional: false });
      // 可选修饰符仍生效，与 readonly 互不影响
      const name = info!.properties.find((p) => p.name === 'name');
      expect(name).toEqual({ name: 'name', type: { kind: 'string' }, optional: true });
    });

    it('ReadonlyArray<T>：等同 Array<T>，解析为 array', () => {
      const fn = extractFrom(`export interface GETQuery { tags: ReadonlyArray<string>; }`);
      const info = fn();

      expect(info).not.toBeNull();
      const tags = info!.properties.find((p) => p.name === 'tags');
      expect(tags).toEqual({
        name: 'tags',
        type: { kind: 'array', element: { kind: 'string' } },
        optional: false,
      });
    });

    it('readonly T[]：等同 T[]，解析为 array', () => {
      const fn = extractFrom(`export interface GETQuery { tags: readonly string[]; }`);
      const info = fn();

      expect(info).not.toBeNull();
      const tags = info!.properties.find((p) => p.name === 'tags');
      expect(tags).toEqual({
        name: 'tags',
        type: { kind: 'array', element: { kind: 'string' } },
        optional: false,
      });
    });

    it('readonly T[] 嵌套类型：保留元素类型解析', () => {
      const fn = extractFrom(
        `export interface Item { value: number; } export interface GETQuery { items: readonly Item[]; }`,
      );
      const info = fn();

      expect(info).not.toBeNull();
      const items = info!.properties.find((p) => p.name === 'items');
      expect(items).toEqual({
        name: 'items',
        type: {
          kind: 'array',
          element: {
            kind: 'object',
            properties: [{ name: 'value', type: { kind: 'number' }, optional: false }],
          },
        },
        optional: false,
      });
    });

    it('readonly 元组：等同普通元组，解析为 tuple', () => {
      const fn = extractFrom(`export interface GETQuery { pair: readonly [string, number]; }`);
      const info = fn();

      expect(info).not.toBeNull();
      const pair = info!.properties.find((p) => p.name === 'pair');
      expect(pair).toEqual({
        name: 'pair',
        type: {
          kind: 'tuple',
          elements: [
            { type: { kind: 'string' }, optional: false, rest: false },
            { type: { kind: 'number' }, optional: false, rest: false },
          ],
        },
        optional: false,
      });
    });

    it('readonly 与 coerce 组合：query 场景 number 字段仍被 coerce', () => {
      // 只验证 AST 提取层返回 number kind（coerce 在 zod 代码生成阶段处理）
      const fn = extractFrom(`export interface GETQuery { readonly page: number; }`);
      const info = fn();

      expect(info).not.toBeNull();
      const page = info!.properties.find((p) => p.name === 'page');
      expect(page).toEqual({ name: 'page', type: { kind: 'number' }, optional: false });
    });
  });

  describe('JSDoc 约束标签', () => {
    let constraintDir: string;

    beforeEach(() => {
      constraintDir = join(tmpdir(), `faapi-constraint-${Date.now()}`);
      mkdirSync(constraintDir, { recursive: true });
    });

    afterEach(() => {
      rmSync(constraintDir, { recursive: true, force: true });
    });

    function extractFrom(content: string, typeName = 'GETQuery') {
      const file = join(constraintDir, `${Date.now()}-${Math.random().toString(36).slice(2)}.ts`);
      writeFileSync(file, content);
      const program = createProgram(file);
      return () => extractTypeInfo(program, file, typeName);
    }

    it('数值约束：@max @min @int @positive', () => {
      const fn = extractFrom(`
        export interface GETQuery {
          /**
           * 页码
           * @min 1
           * @max 1000
           * @int
           */
          page: number;
          /**
           * 正数
           * @positive
           */
          amount: number;
        }
      `);
      const info = fn();

      expect(info).not.toBeNull();
      const page = info!.properties.find((p) => p.name === 'page');
      expect(page!.constraints).toEqual([
        { kind: 'min', value: 1 },
        { kind: 'max', value: 1000 },
        { kind: 'int' },
      ]);
      const amount = info!.properties.find((p) => p.name === 'amount');
      expect(amount!.constraints).toEqual([{ kind: 'positive' }]);
    });

    it('长度约束：@maxLength @minLength @length 用于 string', () => {
      const fn = extractFrom(`
        export interface GETQuery {
          /** @minLength 3 @maxLength 20 */
          username: string;
          /** @length 8 */
          code: string;
        }
      `);
      const info = fn();

      expect(info).not.toBeNull();
      const username = info!.properties.find((p) => p.name === 'username');
      expect(username!.constraints).toEqual([
        { kind: 'minLength', value: 3 },
        { kind: 'maxLength', value: 20 },
      ]);
      const code = info!.properties.find((p) => p.name === 'code');
      expect(code!.constraints).toEqual([{ kind: 'length', value: 8 }]);
    });

    it('长度约束：@maxLength 用于 array', () => {
      const fn = extractFrom(`
        export interface GETQuery {
          /** @maxLength 10 */
          tags: string[];
        }
      `);
      const info = fn();

      expect(info).not.toBeNull();
      const tags = info!.properties.find((p) => p.name === 'tags');
      expect(tags!.constraints).toEqual([{ kind: 'maxLength', value: 10 }]);
    });

    it('字符串格式约束：@regex @email @url @uuid', () => {
      const fn = extractFrom(`
        export interface GETQuery {
          /** @regex /^[a-z]+$/i */
          slug: string;
          /** @email */
          email: string;
          /** @url */
          homepage: string;
          /** @uuid */
          id: string;
        }
      `);
      const info = fn();

      expect(info).not.toBeNull();
      const slug = info!.properties.find((p) => p.name === 'slug');
      expect(slug!.constraints).toEqual([{ kind: 'regex', pattern: '^[a-z]+$', flags: 'i' }]);
      const email = info!.properties.find((p) => p.name === 'email');
      expect(email!.constraints).toEqual([{ kind: 'email' }]);
      const homepage = info!.properties.find((p) => p.name === 'homepage');
      expect(homepage!.constraints).toEqual([{ kind: 'url' }]);
      const id = info!.properties.find((p) => p.name === 'id');
      expect(id!.constraints).toEqual([{ kind: 'uuid' }]);
    });

    it('@pattern 是 @regex 的别名', () => {
      const fn = extractFrom(`
        export interface GETQuery {
          /** @pattern /^\\d{4}$/ */
          year: string;
        }
      `);
      const info = fn();

      expect(info).not.toBeNull();
      const year = info!.properties.find((p) => p.name === 'year');
      expect(year!.constraints).toEqual([{ kind: 'regex', pattern: '^\\d{4}$' }]);
    });

    it('数值约束剩余标签：@negative @nonnegative @nonpositive', () => {
      const fn = extractFrom(`
        export interface GETQuery {
          /** @negative */
          debt: number;
          /** @nonnegative */
          count: number;
          /** @nonpositive */
          offset: number;
        }
      `);
      const info = fn();

      expect(info).not.toBeNull();
      expect(info!.properties.find((p) => p.name === 'debt')!.constraints).toEqual([
        { kind: 'negative' },
      ]);
      expect(info!.properties.find((p) => p.name === 'count')!.constraints).toEqual([
        { kind: 'nonnegative' },
      ]);
      expect(info!.properties.find((p) => p.name === 'offset')!.constraints).toEqual([
        { kind: 'nonpositive' },
      ]);
    });

    it('无 JSDoc 注释的字段无 constraints', () => {
      const fn = extractFrom(`
        export interface GETQuery { name: string; }
      `);
      const info = fn();

      expect(info).not.toBeNull();
      const name = info!.properties.find((p) => p.name === 'name');
      expect(name!.constraints).toBeUndefined();
    });

    it('非约束 JSDoc 标签（@param 等）不影响 constraints', () => {
      const fn = extractFrom(`
        export interface GETQuery {
          /**
           * 用户名
           * @param name - 描述
           * @example alice
           */
          name: string;
        }
      `);
      const info = fn();

      expect(info).not.toBeNull();
      const name = info!.properties.find((p) => p.name === 'name');
      expect(name!.constraints).toBeUndefined();
    });

    it('type 别名内联对象字段也支持约束', () => {
      const fn = extractFrom(`
        export type GETQuery = {
          /** @min 0 */
          count: number;
        };
      `);
      const info = fn();

      expect(info).not.toBeNull();
      const count = info!.properties.find((p) => p.name === 'count');
      expect(count!.constraints).toEqual([{ kind: 'min', value: 0 }]);
    });

    it('类型不匹配抛 SchemaExtractionError：@max 用于 string', () => {
      const fn = extractFrom(`
        export interface GETQuery {
          /** @max 100 */
          name: string;
        }
      `);
      expect(fn).toThrow(SchemaExtractionError);
      expect(fn).toThrow(/@max 约束仅适用于 number 字段，实际为 string/);
    });

    it('类型不匹配抛 SchemaExtractionError：@maxLength 用于 number', () => {
      const fn = extractFrom(`
        export interface GETQuery {
          /** @maxLength 10 */
          count: number;
        }
      `);
      expect(fn).toThrow(SchemaExtractionError);
      expect(fn).toThrow(/@maxLength 约束仅适用于 string 或 array 字段，实际为 number/);
    });

    it('类型不匹配抛 SchemaExtractionError：@email 用于 number', () => {
      const fn = extractFrom(`
        export interface GETQuery {
          /** @email */
          count: number;
        }
      `);
      expect(fn).toThrow(SchemaExtractionError);
      expect(fn).toThrow(/@email 约束仅适用于 string 字段，实际为 number/);
    });

    it('类型不匹配抛 SchemaExtractionError：@regex 用于 number', () => {
      const fn = extractFrom(`
        export interface GETQuery {
          /** @regex /^\\d+$/ */
          count: number;
        }
      `);
      expect(fn).toThrow(SchemaExtractionError);
      expect(fn).toThrow(/@regex 约束仅适用于 string 字段，实际为 number/);
    });

    it('@max 缺值抛错', () => {
      const fn = extractFrom(`
        export interface GETQuery {
          /** @max */
          count: number;
        }
      `);
      expect(fn).toThrow(SchemaExtractionError);
      expect(fn).toThrow(/@max 标签需要一个数字值/);
    });

    it('@max 非数字抛错', () => {
      const fn = extractFrom(`
        export interface GETQuery {
          /** @max abc */
          count: number;
        }
      `);
      expect(fn).toThrow(SchemaExtractionError);
      expect(fn).toThrow(/不是有效数字/);
    });

    it('@regex 非 /pattern/flags 形式抛错', () => {
      const fn = extractFrom(`
        export interface GETQuery {
          /** @regex abc */
          name: string;
        }
      `);
      expect(fn).toThrow(SchemaExtractionError);
      expect(fn).toThrow(/不是 \/pattern\/flags 形式/);
    });
  });

  describe('不支持的类型抛 SchemaExtractionError', () => {
    let unsupportedDir: string;

    beforeEach(() => {
      unsupportedDir = join(tmpdir(), `faapi-unsupported-${Date.now()}`);
      mkdirSync(unsupportedDir, { recursive: true });
    });

    afterEach(() => {
      rmSync(unsupportedDir, { recursive: true, force: true });
    });

    function extractFrom(content: string, typeName = 'GETQuery') {
      const file = join(unsupportedDir, `${Date.now()}-${Math.random().toString(36).slice(2)}.ts`);
      writeFileSync(file, content);
      const program = createProgram(file);
      return () => extractTypeInfo(program, file, typeName);
    }

    it('Map<K, V> 抛错', () => {
      const fn = extractFrom(`export interface GETQuery { data: Map<string, number>; }`);
      expect(fn).toThrow(SchemaExtractionError);
      expect(fn).toThrow(/Map/);
    });

    it('Set<T> 抛错', () => {
      const fn = extractFrom(`export interface GETQuery { data: Set<string>; }`);
      expect(fn).toThrow(SchemaExtractionError);
      expect(fn).toThrow(/Set/);
    });

    it('Promise<T> 抛错', () => {
      const fn = extractFrom(`export interface GETQuery { data: Promise<number>; }`);
      expect(fn).toThrow(SchemaExtractionError);
      expect(fn).toThrow(/Promise/);
    });

    it('Pick 的 T 非 object 时抛错', () => {
      const fn = extractFrom(`export type GETQuery = Pick<string, 'length'>;`);
      expect(fn).toThrow(SchemaExtractionError);
    });

    it('Pick 的 K 为 number 时抛错', () => {
      const fn = extractFrom(
        `export interface User { id: number; name: string; }
export type GETQuery = Pick<User, number>;`,
      );
      expect(fn).toThrow(SchemaExtractionError);
    });

    it('无法解析的引用类型抛错', () => {
      const fn = extractFrom(`export type GETQuery = SomeUnknownType;`);
      expect(fn).toThrow(SchemaExtractionError);
    });

    it('any 抛错（应使用 unknown）', () => {
      const fn = extractFrom(`export interface GETQuery { data: any; }`);
      expect(fn).toThrow(SchemaExtractionError);
      expect(fn).toThrow(/any/);
    });

    it('void 抛错', () => {
      const fn = extractFrom(`export interface GETQuery { data: void; }`);
      expect(fn).toThrow(SchemaExtractionError);
    });

    it('never 抛错', () => {
      const fn = extractFrom(`export interface GETQuery { data: never; }`);
      expect(fn).toThrow(SchemaExtractionError);
    });

    it('object 抛错（应使用 unknown 或具体对象类型）', () => {
      const fn = extractFrom(`export interface GETQuery { data: object; }`);
      expect(fn).toThrow(SchemaExtractionError);
      expect(fn).toThrow(/object/);
    });

    it('unknown 不抛错（显式声明不校验）', () => {
      const file = join(unsupportedDir, 'unknown-ok.ts');
      writeFileSync(file, `export interface GETQuery { data: unknown; name: string; }`);
      const program = createProgram(file);
      const info = extractTypeInfo(program, file, 'GETQuery');
      expect(info).not.toBeNull();
      const data = info!.properties.find((p) => p.name === 'data');
      expect(data!.type).toEqual({ kind: 'any' });
    });

    it('错误信息包含文件路径（上层 catch 补充）', () => {
      const file = join(unsupportedDir, 'has-path.ts');
      writeFileSync(file, `export interface GETQuery { data: Map<string, number>; }`);
      const program = createProgram(file);
      try {
        extractTypeInfo(program, file, 'GETQuery');
        expect.unreachable('应抛错');
      } catch (err) {
        expect(err).toBeInstanceOf(SchemaExtractionError);
        expect((err as Error).message).toContain('has-path.ts');
      }
    });
  });
});
