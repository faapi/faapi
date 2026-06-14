import type { ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

/**
 * 将 Web Response 写入 Node.js ServerResponse
 *
 * 使用 stream pipe 处理背压，避免高并发下内存膨胀。
 */
export async function sendNodeResponse(response: Response, res: ServerResponse): Promise<void> {
  // 设置状态码
  res.statusCode = response.status;

  // 设置 headers
  for (const [key, value] of response.headers) {
    if (key.toLowerCase() === 'set-cookie') {
      // Set-Cookie 使用 appendHeader 支持多个值
      res.appendHeader(key, value);
    } else {
      res.setHeader(key, value);
    }
  }

  // 写入 body（使用 pipe 处理背压）
  if (response.body) {
    // TS 5.7 lib.dom 的 ReadableStream 与 node:stream/web 的 ReadableStream 是不同类型，cast 绕过
    const nodeStream = Readable.fromWeb(response.body as never);
    await new Promise<void>((resolve, reject) => {
      nodeStream.on('error', reject);
      res.on('error', reject);
      res.on('finish', resolve);
      nodeStream.pipe(res);
    });
    return;
  }

  res.end();
}
