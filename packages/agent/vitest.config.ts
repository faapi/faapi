import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // 测试时直接加载主包 src 源码，无需先构建
      // 注意：更精确的规则（含 /src、/testing）需放在前面
      '@faapi/faapi/testing': path.resolve(__dirname, '../faapi/src/testing.ts'),
      '@faapi/faapi/src': path.resolve(__dirname, '../faapi/src'),
      '@faapi/faapi': path.resolve(__dirname, '../faapi/src/index.ts'),
    },
  },
  test: {
    globals: true,
    // 泄漏即失败守卫（同主包 vitest.setup.ts——agent e2e 也建 app 单例）
    setupFiles: ['../faapi/vitest.setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['node_modules', 'dist'],
    testTimeout: 15000,
    fileParallelism: true,
    maxWorkers: '50%',
    // e2e 测试含服务器启动（createProdApp），用 forks 避免 worker 线程崩溃
    pool: 'forks',
  },
});
