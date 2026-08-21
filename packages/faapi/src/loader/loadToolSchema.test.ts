import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadToolSchema } from './loadToolSchema';
import type { ToolMetadata } from '../ast/extractToolMetadata';

/**
 * loadToolSchema 测试：动态加载 tool 的 zod.js schema 模块
 *
 * 覆盖：
 * - 成功加载 zod.js，返回 schema 对象（有 safeParse 方法）
 * - 无 inputTypeName → 返回 undefined
 * - zod.js 文件不存在 → 返回 undefined
 * - 导出名不匹配 → 返回 undefined
 * - zod.js 语法错误（import 失败）→ 返回 undefined
 */
describe('loadToolSchema', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(
      tmpdir(),
      `faapi-load-tool-schema-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** 写入 fixture 文件（返回绝对路径） */
  function writeFile(relPath: string, content: string): string {
    const abs = join(tempDir, ...relPath.split('/'));
    mkdirSync(join(tempDir, ...relPath.split('/').slice(0, -1)), { recursive: true });
    writeFileSync(abs, content, 'utf-8');
    return abs;
  }

  /** 构造 ToolMetadata */
  function toolMeta(opts: {
    name?: string;
    inputTypeName?: string;
    filePath?: string;
  }): ToolMetadata {
    return {
      name: opts.name ?? 'weather.getWeather',
      functionName: 'getWeather',
      inputTypeName: opts.inputTypeName,
      filePath: opts.filePath ?? 'dist/tools/weather/handler.js',
    };
  }

  describe('成功加载', () => {
    it('加载 zod.js 返回 schema 对象（有 safeParse 方法）', async () => {
      writeFile(
        'dist/tools/weather/zod.js',
        `import { z } from 'zod';\nexport const WeatherInputSchema = z.object({ city: z.string() });\n`,
      );

      const result = await loadToolSchema(toolMeta({ inputTypeName: 'WeatherInput' }), tempDir);

      expect(result).toBeDefined();
      expect(result!.schemaName).toBe('WeatherInputSchema');
      // zod schema 有 safeParse 方法（schema 是 unknown,断言为 zod schema 形状后访问）
      const schema = result!.schema as { safeParse: (input: unknown) => { success: boolean } };
      expect(typeof schema.safeParse).toBe('function');

      // 验证 schema 校验行为
      const valid = schema.safeParse({ city: '北京' });
      expect(valid.success).toBe(true);

      const invalid = schema.safeParse({});
      expect(invalid.success).toBe(false);
    });
  });

  describe('返回 undefined 的场景', () => {
    it('无 inputTypeName → 返回 undefined', async () => {
      const result = await loadToolSchema(toolMeta({ inputTypeName: undefined }), tempDir);
      expect(result).toBeUndefined();
    });

    it('zod.js 文件不存在 → 返回 undefined', async () => {
      // 不创建 zod.js 文件
      const result = await loadToolSchema(toolMeta({ inputTypeName: 'WeatherInput' }), tempDir);
      expect(result).toBeUndefined();
    });

    it('导出名不匹配 → 返回 undefined', async () => {
      writeFile(
        'dist/tools/weather/zod.js',
        `import { z } from 'zod';\nexport const OtherSchema = z.object({});\n`,
      );

      // inputTypeName 是 WeatherInput，但 zod.js 导出的是 OtherSchema
      const result = await loadToolSchema(toolMeta({ inputTypeName: 'WeatherInput' }), tempDir);
      expect(result).toBeUndefined();
    });

    it('zod.js 语法错误 → 返回 undefined', async () => {
      writeFile(
        'dist/tools/weather/zod.js',
        `import { z } from 'zod';\nexport const WeatherInputSchema = ;\n`,
      );

      const result = await loadToolSchema(toolMeta({ inputTypeName: 'WeatherInput' }), tempDir);
      expect(result).toBeUndefined();
    });
  });

  describe('路径计算', () => {
    it('filePath 含 dist 前缀（产物形式）→ 正确计算 zod.js 路径', async () => {
      writeFile(
        'dist/tools/weather/zod.js',
        `import { z } from 'zod';\nexport const WeatherInputSchema = z.object({ city: z.string() });\n`,
      );

      const result = await loadToolSchema(
        toolMeta({
          inputTypeName: 'WeatherInput',
          filePath: 'dist/tools/weather/handler.js',
        }),
        tempDir,
      );
      expect(result).toBeDefined();
    });

    it('filePath 是 src 源码形式 → 正确计算 zod.js 路径', async () => {
      // src 源码形式 → getRuntimeToolSchemaPath strip src/ + join dist
      writeFile(
        'dist/tools/weather/zod.js',
        `import { z } from 'zod';\nexport const WeatherInputSchema = z.object({ city: z.string() });\n`,
      );

      const result = await loadToolSchema(
        toolMeta({
          inputTypeName: 'WeatherInput',
          filePath: 'src/tools/weather/handler.ts',
        }),
        tempDir,
      );
      expect(result).toBeDefined();
    });
  });
});
