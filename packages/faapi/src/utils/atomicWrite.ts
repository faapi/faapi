import path from 'node:path';
import fs from 'node:fs';

/**
 * 原子写文件：先写临时文件再 rename 替换
 *
 * rename 在同一文件系统上是原子的（POSIX），并发读者要么看到旧文件要么看到
 * 新文件，不会读到截断的半成品。用于运行时会 import 的产物（zod.js、路由清单、
 * tool/agent 清单）——dev watch 重建与在途请求并发时，非原子写会让请求 import
 * 到半成品文件，报 SyntaxError/ENOENT 且错误信息不指向根因。
 *
 * 与 compileSourceFiles 的 esbuild 原子写（write:false + tmp + rename）同源语义。
 *
 * @param outputPath 目标绝对路径
 * @param content 文件内容
 */
export async function atomicWriteFile(outputPath: string, content: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  const tmp = `${outputPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  await fs.promises.writeFile(tmp, content, 'utf-8');
  await fs.promises.rename(tmp, outputPath);
}
