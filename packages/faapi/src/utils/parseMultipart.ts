/**
 * 解析 multipart/form-data 请求
 * 使用 Web 标准 Request.formData() API
 */

export interface UploadedFile {
  name: string; // 字段名
  filename: string; // 原始文件名
  type: string; // MIME 类型
  size: number; // 文件大小（字节）
  arrayBuffer: () => Promise<ArrayBuffer>; // 获取文件内容
}

export interface MultipartResult {
  /** 表单字段（同名字段用数组收集，单值保持 string） */
  fields: Record<string, string | string[]>;
  files: UploadedFile[];
}

/**
 * 解析 multipart/form-data
 *
 * 同名字段的处理：
 * - 第一次出现：string
 * - 第二次出现：string[]（包含所有同名字段的值）
 * - 文件始终收集到 files 数组（通过 name 字段标识归属）
 */
export async function parseMultipart(request: Request): Promise<MultipartResult> {
  const formData = await request.formData();
  const fields: Record<string, string | string[]> = {};
  const files: UploadedFile[] = [];

  for (const [key, value] of formData.entries()) {
    if (value instanceof File) {
      files.push({
        name: key,
        filename: value.name,
        type: value.type,
        size: value.size,
        arrayBuffer: () => value.arrayBuffer(),
      });
    } else {
      // 同名字段收集为数组
      if (key in fields) {
        const existing = fields[key];
        if (Array.isArray(existing)) {
          existing.push(value);
        } else {
          fields[key] = [existing, value];
        }
      } else {
        fields[key] = value;
      }
    }
  }

  return { fields, files };
}
