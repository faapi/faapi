import type { ValidatorFn } from '../ast/generateValidatorCode';
import type { PropertyType } from '../ast/resolveTypeNode';

/**
 * 单个 schema 条目
 * - SchemaEntry：有类型声明，包含 properties（用于 coerce）和 validator（用于校验）
 * - null：handler 无类型声明（如 GET() 无参数），跳过校验
 */
export type SchemaEntry = { properties: PropertyType[]; validator: ValidatorFn } | null;

/**
 * 单个文件的所有 schema：schemaName -> SchemaEntry
 * schemaName 由 method + inputType 生成，如 'GETQuery'、'POSTBody'
 */
export type FileSchemas = Map<string, SchemaEntry>;

/**
 * 完整 manifest：filePath -> FileSchemas
 */
export type SchemaManifest = Map<string, FileSchemas>;

/**
 * Schema 注册表（单例）
 *
 * 统一管理 handler 的校验函数，作为 validateInput 的唯一数据来源。
 * - prd 模式：从 dist/faapi-schema.js import 加载
 * - dev 模式：启动时全量提取并生成函数，watch 时全量重建
 *
 * 三种状态区分：
 * - get() 返回 SchemaEntry：有类型声明，校验
 * - get() 返回 null：无类型声明，跳过校验
 * - get() 返回 undefined：manifest 不完整，抛错
 */
class SchemaRegistry {
  private manifest: SchemaManifest = new Map();

  /**
   * 批量加载 manifest
   * 覆盖已有数据
   */
  loadManifest(manifest: SchemaManifest): void {
    this.manifest.clear();
    for (const [filePath, fileSchemas] of manifest) {
      const copy: FileSchemas = new Map();
      fileSchemas.forEach((value, key) => copy.set(key, value));
      this.manifest.set(filePath, copy);
    }
  }

  /**
   * 查询单条 schema
   * @returns SchemaEntry | null | undefined
   *          - SchemaEntry：有类型声明
   *          - null：无类型声明（跳过校验）
   *          - undefined：manifest 不完整（抛错）
   */
  get(filePath: string, schemaName: string): SchemaEntry | undefined {
    const fileSchemas = this.manifest.get(filePath);
    if (!fileSchemas) return undefined;
    return fileSchemas.get(schemaName);
  }

  /**
   * 设置单个文件的所有 schema
   * 覆盖该文件的已有数据
   */
  set(filePath: string, schemas: FileSchemas): void {
    const copy: FileSchemas = new Map();
    schemas.forEach((value, key) => copy.set(key, value));
    this.manifest.set(filePath, copy);
  }

  /**
   * 删除单个文件（文件被删除时）
   */
  delete(filePath: string): void {
    this.manifest.delete(filePath);
  }

  /**
   * 判断文件是否已注册
   */
  hasFile(filePath: string): boolean {
    return this.manifest.has(filePath);
  }

  /**
   * 清空（测试用 / watch 全量重建前）
   */
  clear(): void {
    this.manifest.clear();
  }

  /**
   * 已注册的文件数量
   */
  get size(): number {
    return this.manifest.size;
  }
}

/**
 * 全局单例
 */
export const schemaRegistry = new SchemaRegistry();
