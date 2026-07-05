import { defineConfig } from 'vitest/config';

const isCI = !!process.env.CI;

// E2E 测试访问的是本机 127.0.0.1 / localhost，需绕过 HTTP 代理
// （开发机常驻 Clash 等代理，Node 24+ 默认 NODE_USE_ENV_PROXY=1 会让 fetch 走代理，
// 代理未启动时 ECONNREFUSED）。保留用户已有的 NO_PROXY 项，仅追加本机地址。
{
  const targets = ['localhost', '127.0.0.1'];
  const existing = (process.env.NO_PROXY ?? '').split(',').map((s) => s.trim());
  const merged = Array.from(new Set([...targets, ...existing])).filter(Boolean);
  process.env.NO_PROXY = merged.join(',');
  process.env.no_proxy = merged.join(',');
}

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
