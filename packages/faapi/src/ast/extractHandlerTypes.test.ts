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
