import { defineConfig } from 'vitest/config';

const isCI = !!process.env.CI;

export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['node_modules', 'dist'],
    // E2E 测试含服务器启动 + 路由扫描，全量并行时 CPU 竞争会超过默认 5s
    testTimeout: 15000,
    // CI（2 核）资源紧张，E2E 服务器启动 + AST 提取并行易导致 fork 子进程崩溃
    // （ERR_IPC_CHANNEL_CLOSED）；本地（多核）保持并行加速
    fileParallelism: !isCI,
    maxWorkers: isCI ? 1 : '50%',
    // CI 下所有测试共享单个 fork 进程，避免进程间 IPC 在资源紧张时关闭
    // （ERR_IPC_CHANNEL_CLOSED）；本地保持多 fork 并行加速
    // https://vitest.dev/config/#pooloptions
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: isCI,
        minForks: isCI ? 1 : undefined,
        maxForks: isCI ? 1 : undefined,
      },
    },
  },
});

