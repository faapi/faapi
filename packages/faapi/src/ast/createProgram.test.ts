import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProgram, invalidateProgramCache } from './createProgram';
import { extractTypeInfo } from './extractHandlerTypes';

/**
 * createProgram 测试
 *
 * 重点验证：业务项目用 `moduleResolution: Bundler` + 无扩展名相对导入时,
 * checker 能正确绑定跨文件 `import type` 的 symbol,使 `resolveTypeReference`
 * 能递归解析跨文件类型(修复 SchemaExtractionError "无法解析的引用类型")。
 */
describe('createProgram', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `faapi-cp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    // 每个测试独立缓存,避免互相干扰
    invalidateProgramCache();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('默认场景(无 tsconfig.json)', () => {
    it('临时目录无 tsconfig 时仍能创建 Program(回退默认 NodeNext)', () => {
      const file = join(tempDir, 'route.ts');
      writeFileSync(
        file,
        `export interface GETQuery { page: number; name?: string; }
export function GET(query: GETQuery) { return query; }`,
      );
      const program = createProgram(file);
      expect(program).toBeDefined();
      const sourceFile = program.getSourceFile(file);
      expect(sourceFile).toBeDefined();
    });

    it('单文件 interface 提取正常(无跨文件 import)', () => {
      const file = join(tempDir, 'route.ts');
      writeFileSync(file, `export interface GETQuery { page: number; }`);
      const program = createProgram(file);
      const info = extractTypeInfo(program, file, 'GETQuery');
      expect(info).not.toBeNull();
      expect(info!.properties).toHaveLength(1);
      expect(info!.properties[0]).toEqual({
        name: 'page',
        type: { kind: 'number' },
        optional: false,
      });
    });
  });

  describe('tsconfig moduleResolution: Bundler(修复跨文件 import type)', () => {
    /**
     * 核心修复场景:业务项目 tsconfig 用 Bundler + 无扩展名相对导入。
     * 修复前:NodeNext 解析不到无后缀 import → checker 拿不到 symbol → 抛 SchemaExtractionError
     * 修复后:读项目 tsconfig 用 Bundler → checker 能解析无后缀 import → 类型提取成功
     */
    it('跨文件 import type 无扩展名能正确解析(Bundler resolution)', () => {
      // 模拟业务项目结构:tempDir/tsconfig.json + tempDir/src/db/schema.ts + tempDir/src/tools/handler.ts
      mkdirSync(join(tempDir, 'src', 'db'), { recursive: true });
      mkdirSync(join(tempDir, 'src', 'tools'), { recursive: true });

      writeFileSync(
        join(tempDir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
            strict: true,
            skipLibCheck: true,
          },
        }),
      );

      writeFileSync(
        join(tempDir, 'src', 'db', 'schema.ts'),
        `export interface StyleGuide {
  /** 句长上限 */
  maxSentenceLength?: number;
  /** 禁用词列表 */
  bannedWords?: string[];
}
`,
      );

      const handlerFile = join(tempDir, 'src', 'tools', 'handler.ts');
      writeFileSync(
        handlerFile,
        `import type { StyleGuide } from '../../db/schema'

export interface NovelSaveInput {
  id?: number
  title: string
  styleGuide?: StyleGuide
}
`,
      );

      const program = createProgram(handlerFile);
      const info = extractTypeInfo(program, handlerFile, 'NovelSaveInput');

      expect(info).not.toBeNull();
      expect(info!.name).toBe('NovelSaveInput');
      expect(info!.properties).toHaveLength(3);

      // 关键断言:跨文件 StyleGuide 能解析为 object(而非抛 SchemaExtractionError)
      const sg = info!.properties.find((p) => p.name === 'styleGuide');
      expect(sg).toBeDefined();
      expect(sg!.optional).toBe(true);
      expect(sg!.type.kind).toBe('object');
      const sgProps = sg!.type.kind === 'object' ? sg!.type.properties : [];
      expect(sgProps).toHaveLength(2);
      expect(sgProps.find((p) => p.name === 'maxSentenceLength')).toBeDefined();
      expect(sgProps.find((p) => p.name === 'bannedWords')).toBeDefined();
    });

    it('跨文件 import type 嵌套引用(多层)能正确解析', () => {
      mkdirSync(join(tempDir, 'src', 'types'), { recursive: true });
      mkdirSync(join(tempDir, 'src', 'api'), { recursive: true });

      writeFileSync(
        join(tempDir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            module: 'ESNext',
            moduleResolution: 'Bundler',
          },
        }),
      );

      // types/base.ts → 定义 Address
      writeFileSync(
        join(tempDir, 'src', 'types', 'base.ts'),
        `export interface Address {
  city: string
  zip: string
}
`,
      );

      // types/user.ts → 引用 Address,定义 User
      writeFileSync(
        join(tempDir, 'src', 'types', 'user.ts'),
        `import type { Address } from './base'
export interface User {
  id: number
  name: string
  address: Address
}
`,
      );

      // api/handler.ts → 引用 User,定义 Body
      const handlerFile = join(tempDir, 'src', 'api', 'handler.ts');
      writeFileSync(
        handlerFile,
        `import type { User } from '../types/user'
export interface POSTBody {
  user: User
}
`,
      );

      const program = createProgram(handlerFile);
      const info = extractTypeInfo(program, handlerFile, 'POSTBody');

      expect(info).not.toBeNull();
      // 验证多层嵌套:Body → User → Address 都能解析
      const userProp = info!.properties.find((p) => p.name === 'user');
      expect(userProp).toBeDefined();
      expect(userProp!.type.kind).toBe('object');
      const userProps = userProp!.type.kind === 'object' ? userProp!.type.properties : [];
      const addressProp = userProps.find((p) => p.name === 'address');
      expect(addressProp).toBeDefined();
      expect(addressProp!.type.kind).toBe('object');
      const addrProps = addressProp!.type.kind === 'object' ? addressProp!.type.properties : [];
      expect(addrProps.map((p) => p.name).sort()).toEqual(['city', 'zip']);
    });

    it('跨文件 import type 引用 enum 能正确解析', () => {
      mkdirSync(join(tempDir, 'src', 'enums'), { recursive: true });
      mkdirSync(join(tempDir, 'src', 'api'), { recursive: true });

      writeFileSync(
        join(tempDir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            module: 'ESNext',
            moduleResolution: 'Bundler',
          },
        }),
      );

      writeFileSync(
        join(tempDir, 'src', 'enums', 'status.ts'),
        `export enum Status {
  Draft = 'draft',
  Published = 'published',
  Archived = 'archived',
}
`,
      );

      const handlerFile = join(tempDir, 'src', 'api', 'handler.ts');
      writeFileSync(
        handlerFile,
        `import type { Status } from '../enums/status'
export interface POSTBody {
  status: Status
}
`,
      );

      const program = createProgram(handlerFile);
      const info = extractTypeInfo(program, handlerFile, 'POSTBody');
      expect(info).not.toBeNull();
      const statusProp = info!.properties.find((p) => p.name === 'status');
      expect(statusProp).toBeDefined();
      // enum 解析为字面量联合
      expect(statusProp!.type.kind).toBe('union');
    });
  });

  describe('tsconfig 其他 resolution 模式', () => {
    it('moduleResolution: NodeNext + 带扩展名导入能解析', () => {
      mkdirSync(join(tempDir, 'src', 'db'), { recursive: true });
      mkdirSync(join(tempDir, 'src', 'tools'), { recursive: true });

      writeFileSync(
        join(tempDir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
          },
        }),
      );

      writeFileSync(
        join(tempDir, 'src', 'db', 'schema.ts'),
        `export interface StyleGuide { maxLen?: number }`,
      );

      // NodeNext 模式下相对导入必须带 .js 后缀(ESM 规范)
      const handlerFile = join(tempDir, 'src', 'tools', 'handler.ts');
      writeFileSync(
        handlerFile,
        `import type { StyleGuide } from '../../db/schema.js'
export interface NovelSaveInput { sg: StyleGuide }
`,
      );

      const program = createProgram(handlerFile);
      const info = extractTypeInfo(program, handlerFile, 'NovelSaveInput');
      expect(info).not.toBeNull();
      const sg = info!.properties.find((p) => p.name === 'sg');
      expect(sg).toBeDefined();
      expect(sg!.type.kind).toBe('object');
    });
  });

  describe('缓存行为', () => {
    it('同一文件多次调用返回同一 Program 实例(缓存命中)', () => {
      const file = join(tempDir, 'route.ts');
      writeFileSync(file, `export interface Q { a: number }`);
      const p1 = createProgram(file);
      const p2 = createProgram(file);
      expect(p1).toBe(p2);
    });

    it('invalidateProgramCache 后重新创建返回新 Program 实例', () => {
      const file = join(tempDir, 'route.ts');
      writeFileSync(file, `export interface Q { a: number }`);
      const p1 = createProgram(file);
      invalidateProgramCache();
      const p2 = createProgram(file);
      expect(p1).not.toBe(p2);
    });

    it('不同文件返回不同 Program 实例', () => {
      const f1 = join(tempDir, 'a.ts');
      const f2 = join(tempDir, 'b.ts');
      writeFileSync(f1, `export interface Q { a: number }`);
      writeFileSync(f2, `export interface Q { b: number }`);
      const p1 = createProgram(f1);
      const p2 = createProgram(f2);
      expect(p1).not.toBe(p2);
    });
  });

  describe('tsconfig 解析鲁棒性', () => {
    it('tsconfig.json 不存在时回退默认(不抛错)', () => {
      const file = join(tempDir, 'route.ts');
      writeFileSync(file, `export interface Q { a: number }`);
      expect(() => createProgram(file)).not.toThrow();
    });

    it('tsconfig.json 语法错误时回退默认(不抛错,保证 build 不被 tsconfig 损坏阻塞)', () => {
      writeFileSync(join(tempDir, 'tsconfig.json'), `{ invalid json,,, }`);
      const file = join(tempDir, 'route.ts');
      writeFileSync(file, `export interface Q { a: number }`);
      expect(() => createProgram(file)).not.toThrow();
      // 单文件 interface 提取仍正常
      const program = createProgram(file);
      const info = extractTypeInfo(program, file, 'Q');
      expect(info).not.toBeNull();
    });

    it('tsconfig.json 缺少 compilerOptions 时回退默认', () => {
      writeFileSync(join(tempDir, 'tsconfig.json'), JSON.stringify({ extends: '../base' }));
      const file = join(tempDir, 'route.ts');
      writeFileSync(file, `export interface Q { a: number }`);
      expect(() => createProgram(file)).not.toThrow();
    });

    it('tsconfig.json 只读 moduleResolution 不读其他字段(jsx 不影响)', () => {
      mkdirSync(join(tempDir, 'src'), { recursive: true });
      // 业务项目带 jsx / paths 等配置,不应干扰 AST 提取
      writeFileSync(
        join(tempDir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            module: 'ESNext',
            moduleResolution: 'Bundler',
            jsx: 'react-jsx',
            paths: { '@/*': ['./*'] },
            baseUrl: '.',
            target: 'ES2020',
            strict: false, // 框架默认 true 不应被覆盖
          },
        }),
      );

      const file = join(tempDir, 'src', 'route.ts');
      writeFileSync(file, `export interface Q { a: number; b: string }`);
      const program = createProgram(file);
      const info = extractTypeInfo(program, file, 'Q');
      expect(info).not.toBeNull();
      expect(info!.properties).toHaveLength(2);
    });

    it('子目录文件向上查找父级 tsconfig.json', () => {
      mkdirSync(join(tempDir, 'src', 'deep', 'nested'), { recursive: true });

      writeFileSync(
        join(tempDir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            module: 'ESNext',
            moduleResolution: 'Bundler',
          },
        }),
      );

      // 在深层子目录写文件,createProgram 应向上找到 tempDir/tsconfig.json
      const deepFile = join(tempDir, 'src', 'deep', 'nested', 'route.ts');
      writeFileSync(deepFile, `export interface Q { a: number }`);
      const program = createProgram(deepFile);
      const info = extractTypeInfo(program, deepFile, 'Q');
      expect(info).not.toBeNull();
    });

    it('tsconfig 缓存:同目录多个文件共享 tsconfig 解析结果', () => {
      mkdirSync(join(tempDir, 'src'), { recursive: true });
      writeFileSync(
        join(tempDir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: { moduleResolution: 'Bundler', module: 'ESNext' },
        }),
      );

      const f1 = join(tempDir, 'src', 'a.ts');
      const f2 = join(tempDir, 'src', 'b.ts');
      writeFileSync(f1, `export interface A { x: number }`);
      writeFileSync(f2, `export interface B { y: string }`);

      // 两个文件共享同一 tsconfig,缓存命中不应重复读盘
      expect(() => {
        createProgram(f1);
        createProgram(f2);
      }).not.toThrow();
    });
  });
});
