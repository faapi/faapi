import type { ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

/**
 * 将 Web Response 写入 Node.js ServerResponse
 *
 * 使用 stream pipe 处理背压，避免高并发下内存膨胀。
 *
 * 断连语义：客户端中断（res 'error' / 提前 'close'）时销毁源流并按正常完成收尾——
 * 网络中断不是服务端错误，不进入 500 兜底、不触发 onError；destroy 使底层
 * web ReadableStream 触发 cancel()，上游生产者（如 SseWriter）感知 aborted
 * 停止推送，避免数据堆积在无消费者的流 buffer 中（内存泄漏）。
 * 源流自身错误（handler 流式写失败）仍 reject，走正常错误响应路径。
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
      // 源流错误：真实错误 → reject（handleRequest catch 走错误响应）
      nodeStream.on('error', reject);

      // 客户端断开：销毁源流（触发底层 cancel）+ resolve（不当作服务端错误）
      const abort = () => {
        nodeStream.destroy();
        resolve();
      };
      res.on('error', abort);
      res.on('close', () => {
        // 正常完成也会触发 'close'（在 'finish' 之后，此时 writableEnded=true），不视为断连
        if (!res.writableEnded) abort();
      });

      res.on('finish', resolve);
      nodeStream.pipe(res);
    });
    return;
  }

  res.end();
}
