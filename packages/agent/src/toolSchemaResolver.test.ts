import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ─── Mock @faapi/faapi ───────────────────────────────
// 只 mock loadToolSchema（zod.js 加载）——getToolSchemaPath 是纯路径计算，
// mtime 缓存测试需要它指向真实 tmp 文件做 statSync
vi.mock('@faapi/faapi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@faapi/faapi')>();
  return {
    ...actual,
    loadToolSchema: vi.fn(),
  };
});

// ─── 导入（mock 后）─────────────────────────────────
import { createToolSchemaResolver } from './toolSchemaResolver';
import { loadToolSchema, getToolSchemaPath, type ToolMetadata } from '@faapi/faapi';
import { z } from 'zod';

// ─── 测试数据 ───────────────────────────────────────
const testTool: ToolMetadata = {
  name: 'test.tool',
  functionName: 'testFn',
  inputTypeName: 'TestInput',
  filePath: 'dist/tools/test/handler.js',
};

const otherTool: ToolMetadata = {
  name: 'other.tool',
  functionName: 'otherFn',
  inputTypeName: 'OtherInput',
  filePath: 'dist/tools/other/handler.js',
};

beforeEach(() => {
  vi.mocked(loadToolSchema).mockReset();
});

describe('createToolSchemaResolver', () => {
  describe('解析（ToolSchemaModule → ToolSchemaResolution）', () => {
    it('loadToolSchema 有结果时返回 jsonSchema + validate', async () => {
      vi.mocked(loadToolSchema).mockResolvedValue({
        schema: z.object({ city: z.string() }),
        schemaName: 'TestInputSchema',
      });

      const resolveToolSchema = createToolSchemaResolver({ rootDir: '/project' });
      const res = await resolveToolSchema(testTool);

      expect(res).toBeDefined();
      expect(res!.jsonSchema.type).toBe('object');
      expect((res!.jsonSchema as Record<string, unknown>).properties).toMatchObject({
        city: { type: 'string' },
      });
      expect(typeof res!.validate).toBe('function');
    });

    it('validate 成功返回 { ok: true, value }', async () => {
      vi.mocked(loadToolSchema).mockResolvedValue({
        schema: z.object({ city: z.string() }),
        schemaName: 'TestInputSchema',
      });

      const resolveToolSchema = createToolSchemaResolver({ rootDir: '/project' });
      const res = await resolveToolSchema(testTool);
      const validated = res!.validate({ city: 'Beijing' });

      expect(validated).toEqual({ ok: true, value: { city: 'Beijing' } });
    });

    it('validate 失败返回 { ok: false, error }（不抛错）', async () => {
      vi.mocked(loadToolSchema).mockResolvedValue({
        schema: z.object({ city: z.string() }),
        schemaName: 'TestInputSchema',
      });

      const resolveToolSchema = createToolSchemaResolver({ rootDir: '/project' });
      const res = await resolveToolSchema(testTool);
      const validated = res!.validate({ city: 123 });

      expect(validated.ok).toBe(false);
      if (!validated.ok) {
        expect(typeof validated.error).toBe('string');
        expect(validated.error.length).toBeGreaterThan(0);
      }
    });

    it('loadToolSchema 返回 undefined 时透传 undefined（自由 schema 语义）', async () => {
      vi.mocked(loadToolSchema).mockResolvedValue(undefined);

      const resolveToolSchema = createToolSchemaResolver({ rootDir: '/project' });
      const res = await resolveToolSchema(testTool);

      expect(res).toBeUndefined();
    });

    it('rootDir 缺省时以 process.cwd() 调 loadToolSchema', async () => {
      vi.mocked(loadToolSchema).mockResolvedValue(undefined);

      const resolveToolSchema = createToolSchemaResolver();
      await resolveToolSchema(testTool);

      expect(vi.mocked(loadToolSchema)).toHaveBeenCalledWith(testTool, process.cwd());
    });
  });

  describe('mtime 缓存', () => {
    it('同一 tool 重复调用命中缓存（loadToolSchema 只调一次）', async () => {
      vi.mocked(loadToolSchema).mockResolvedValue({
        schema: z.object({ city: z.string() }),
        schemaName: 'TestInputSchema',
      });

      const resolveToolSchema = createToolSchemaResolver({ rootDir: '/project' });
      await resolveToolSchema(testTool);
      await resolveToolSchema(testTool);

      expect(vi.mocked(loadToolSchema)).toHaveBeenCalledTimes(1);
    });

    it('不同 tool 各自解析', async () => {
      vi.mocked(loadToolSchema).mockResolvedValue({
        schema: z.object({ city: z.string() }),
        schemaName: 'TestInputSchema',
      });

      const resolveToolSchema = createToolSchemaResolver({ rootDir: '/project' });
      await resolveToolSchema(testTool);
      await resolveToolSchema(otherTool);

      expect(vi.mocked(loadToolSchema)).toHaveBeenCalledTimes(2);
    });

    it('并发调用共享 in-flight Promise（只解析一次）', async () => {
      vi.mocked(loadToolSchema).mockResolvedValue({
        schema: z.object({ city: z.string() }),
        schemaName: 'TestInputSchema',
      });

      const resolveToolSchema = createToolSchemaResolver({ rootDir: '/project' });
      await Promise.all([resolveToolSchema(testTool), resolveToolSchema(testTool)]);

      expect(vi.mocked(loadToolSchema)).toHaveBeenCalledTimes(1);
    });

    it('zod.js mtime 变化后重新解析（dev reloadTools 自愈）', async () => {
      // 真实 tmp 文件：缓存用 statSync 校验 mtime，mock 的 loadToolSchema 不读文件
      const rootDir = join(
        tmpdir(),
        `faapi-agent-resolver-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      const tool = { ...testTool, filePath: 'src/tools/test/handler.js' };
      vi.mocked(loadToolSchema).mockResolvedValue({
        schema: z.object({ city: z.string() }),
        schemaName: 'TestInputSchema',
      });
      const zodPath = getToolSchemaPath(tool, rootDir);
      mkdirSync(join(zodPath, '..'), { recursive: true });
      writeFileSync(zodPath, 'export const TestInputSchema = {};');

      try {
        const resolveToolSchema = createToolSchemaResolver({ rootDir });
        await resolveToolSchema(tool);
        expect(vi.mocked(loadToolSchema)).toHaveBeenCalledTimes(1);

        // bump mtime（模拟 dev reloadTools 重生成 zod.js）
        const later = new Date(Date.now() + 10_000);
        utimesSync(zodPath, later, later);

        await resolveToolSchema(tool);
        // mtime 变化 → 缓存失效 → 重新解析
        expect(vi.mocked(loadToolSchema)).toHaveBeenCalledTimes(2);
      } finally {
        rmSync(rootDir, { recursive: true, force: true });
      }
    });

    it('两次 createToolSchemaResolver 的缓存相互独立', async () => {
      vi.mocked(loadToolSchema).mockResolvedValue({
        schema: z.object({ city: z.string() }),
        schemaName: 'TestInputSchema',
      });

      const resolverA = createToolSchemaResolver({ rootDir: '/project' });
      const resolverB = createToolSchemaResolver({ rootDir: '/project' });
      await resolverA(testTool);
      await resolverB(testTool);

      // B 未命中 A 的缓存 → 各自解析一次
      expect(vi.mocked(loadToolSchema)).toHaveBeenCalledTimes(2);
    });
  });
});
