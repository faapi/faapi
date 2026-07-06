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
    // 内存上限由 package.json 的 test 脚本通过 NODE_OPTIONS=--max-old-space-size=8192
    // 提高（AST 提取测试加载 TypeScript compiler,默认 4GB 堆内存不够）
    fileParallelism: !isCI,
    maxWorkers: isCI ? 1 : '50%',
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
