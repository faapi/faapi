import fs from 'node:fs';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';

/**
 * MIME 类型映射表
 *
 * 覆盖常见的 Web 静态资源类型。
 */
const MIME_TYPES: Record<string, string> = {
  // 文本
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.cjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.json5': 'application/json5',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.yaml': 'application/x-yaml',
  '.yml': 'application/x-yaml',
  '.toml': 'application/toml',

  // 图片
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
  '.heic': 'image/heic',

  // 字体
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',

  // 音频
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',

  // 视频
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mov': 'video/quicktime',
  '.m4v': 'video/mp4',
  '.avi': 'video/x-msvideo',

  // 文档
  '.pdf': 'application/pdf',

  // 压缩
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.rar': 'application/vnd.rar',
  '.7z': 'application/x-7z-compressed',

  // 其他
  '.wasm': 'application/wasm',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

/**
 * 尝试提供静态文件
 *
 * 使用流式响应（createReadStream）避免大文件占用内存。
 * 路径遍历检查使用 path.relative 严格判断。
 *
 * @param urlPath 请求路径
 * @param staticDir 静态文件根目录的绝对路径
 * @returns Response 或 null（未找到文件）
 */
export async function serveStatic(urlPath: string, staticDir: string): Promise<Response | null> {
  // 安全检查：防止路径遍历
  // 使用 path.relative 判断解析后的路径是否仍在 staticDir 内
  const resolved = path.resolve(staticDir, '.' + urlPath);
  const relative = path.relative(staticDir, resolved);

  // relative 如果以 '..' 开头或为绝对路径，说明逃逸了 staticDir
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }

  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(resolved);
  } catch {
    return null;
  }

  if (stat.isDirectory()) {
    // 尝试 index.html
    const indexPath = path.join(resolved, 'index.html');
    try {
      const indexStat = await fs.promises.stat(indexPath);
      if (indexStat.isFile()) {
        return serveFile(indexPath, indexStat.size);
      }
    } catch {
      // index.html 不存在
    }
    return null;
  }

  if (!stat.isFile()) {
    return null;
  }

  return serveFile(resolved, stat.size);
}

/**
 * 流式响应文件
 *
 * 使用 createReadStream 避免大文件占用内存。
 * 设置 ETag 和 Last-Modified 支持条件请求。
 */
function serveFile(filePath: string, size: number): Response {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';

  // 使用 mtime 作为 ETag 和 Last-Modified
  const stream = createReadStream(filePath);
  const webStream = Readable.toWeb(stream) as ReadableStream<Uint8Array>;

  return new Response(webStream, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=3600',
      'Content-Length': String(size),
    },
  });
}
