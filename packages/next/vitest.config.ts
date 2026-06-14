import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@faapi/faapi/src': path.resolve(__dirname, '../faapi/src'),
      '@faapi/faapi': path.resolve(__dirname, '../faapi/src/index.ts'),
      '@faapi/next': path.resolve(__dirname, './src/index.ts'),
    },
  },
  test: {
    globals: true,
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['node_modules', 'dist'],
    // E2E 测试含 Next.js 启动 + 路由扫描,全量并行时 CPU 竞争会超过默认 5s
    testTimeout: 30000,
    fileParallelism: true,
    maxWorkers: '50%',
    // 使用子进程池替代默认的 worker 线程池
    // Next.js 启动 + E2E 服务器在 worker 线程中容易崩溃
    pool: 'forks',
  },
});
