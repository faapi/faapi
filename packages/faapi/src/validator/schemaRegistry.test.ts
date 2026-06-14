import { describe, it, expect, beforeEach } from 'vitest';
import { schemaRegistry, type SchemaManifest, type SchemaEntry } from './schemaRegistry';

// 构造一个简单的 SchemaEntry（包含 properties 和 validator）
function makeSchemaEntry(_name: string): SchemaEntry {
  return {
    properties: [{ name: 'id', type: { kind: 'number' }, optional: false }],
    validator: (() => ({ valid: true, issues: [], data: {} })) as SchemaEntry extends {
      validator: infer F;
    }
      ? F
      : never,
  };
}

describe('schemaRegistry', () => {
  beforeEach(() => {
    schemaRegistry.clear();
  });

  describe('set / get', () => {
    it('set 后能 get 到对应 schema', () => {
      const filePath = 'api/user/handler.ts';
      const schemas = new Map<string, SchemaEntry>([
        ['GETQuery', makeSchemaEntry('GETQuery')],
        ['POSTBody', null],
      ]);

      schemaRegistry.set(filePath, schemas);

      const getQuery = schemaRegistry.get(filePath, 'GETQuery');
      expect(getQuery).not.toBeNull();
      expect(getQuery!.properties[0].name).toBe('id');
      expect(typeof getQuery!.validator).toBe('function');
      expect(schemaRegistry.get(filePath, 'POSTBody')).toBeNull();
    });

    it('未注册的文件返回 undefined', () => {
      expect(schemaRegistry.get('not/registered.ts', 'GETQuery')).toBeUndefined();
    });

    it('文件已注册但 schemaName 不存在返回 undefined', () => {
      const filePath = 'api/user/handler.ts';
      schemaRegistry.set(filePath, new Map([['GETQuery', makeSchemaEntry('GETQuery')]]));

      expect(schemaRegistry.get(filePath, 'POSTBody')).toBeUndefined();
    });

    it('null 表示无类型声明，与 undefined 区分', () => {
      const filePath = 'api/health/handler.ts';
      schemaRegistry.set(filePath, new Map([['GETQuery', null]]));

      const result = schemaRegistry.get(filePath, 'GETQuery');
      expect(result).toBeNull(); // 无类型声明
      expect(result).not.toBeUndefined(); // 不是 manifest 不完整
    });
  });

  describe('hasFile', () => {
    it('已注册返回 true', () => {
      schemaRegistry.set('api/user/handler.ts', new Map());
      expect(schemaRegistry.hasFile('api/user/handler.ts')).toBe(true);
    });

    it('未注册返回 false', () => {
      expect(schemaRegistry.hasFile('not/registered.ts')).toBe(false);
    });
  });

  describe('delete', () => {
    it('删除后 get 返回 undefined', () => {
      const filePath = 'api/user/handler.ts';
      schemaRegistry.set(filePath, new Map([['GETQuery', makeSchemaEntry('GETQuery')]]));

      schemaRegistry.delete(filePath);

      expect(schemaRegistry.get(filePath, 'GETQuery')).toBeUndefined();
      expect(schemaRegistry.hasFile(filePath)).toBe(false);
    });
  });

  describe('loadManifest', () => {
    it('批量加载 manifest', () => {
      const manifest: SchemaManifest = new Map([
        [
          'api/user/handler.ts',
          new Map<string, SchemaEntry>([
            ['GETQuery', makeSchemaEntry('GETQuery')],
            ['POSTBody', makeSchemaEntry('POSTBody')],
          ]),
        ],
        ['api/health/handler.ts', new Map<string, SchemaEntry>([['GETQuery', null]])],
      ]);

      schemaRegistry.loadManifest(manifest);

      const getQuery = schemaRegistry.get('api/user/handler.ts', 'GETQuery');
      const postBody = schemaRegistry.get('api/user/handler.ts', 'POSTBody');
      expect(getQuery).not.toBeNull();
      expect(getQuery!.properties[0].name).toBe('id');
      expect(postBody).not.toBeNull();
      expect(postBody!.properties[0].name).toBe('id');
      expect(schemaRegistry.get('api/health/handler.ts', 'GETQuery')).toBeNull();
    });

    it('loadManifest 覆盖已有数据', () => {
      schemaRegistry.set('api/user/handler.ts', new Map([['GETQuery', makeSchemaEntry('old')]]));
      const manifest: SchemaManifest = new Map([
        [
          'api/user/handler.ts',
          new Map<string, SchemaEntry>([['GETQuery', makeSchemaEntry('new')]]),
        ],
      ]);

      schemaRegistry.loadManifest(manifest);

      const entry = schemaRegistry.get('api/user/handler.ts', 'GETQuery');
      expect(entry).not.toBeNull();
      expect(entry!.properties[0].name).toBe('id');
    });
  });

  describe('clear', () => {
    it('清空所有数据', () => {
      schemaRegistry.set(
        'api/user/handler.ts',
        new Map([['GETQuery', makeSchemaEntry('GETQuery')]]),
      );

      schemaRegistry.clear();

      expect(schemaRegistry.hasFile('api/user/handler.ts')).toBe(false);
    });
  });
});
