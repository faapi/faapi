import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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
  resolve: {
    alias: {
      // 仅用于 testServer.e2e.alias.test.ts：模拟业务项目用 @/ 别名引用 lib 模块
      // （参考 sso 项目 tsconfig.json paths）。其他测试不 import @/，不受影响。
      '@': path.resolve(__dirname, 'fixtures/api-alias/src'),
    },
  },
  test: {
    globals: true,
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['node_modules', 'dist'],
    // E2E 测试含服务器启动 + 路由扫描，全量并行时 CPU 竞争会超过默认 5s
    testTimeout: 15000,
    // E2E 的 beforeAll 含 scanRoutes + AST 提取 + 生成 zod.js，coverage 模式下
    // V8 注入让 setup 变慢，默认 10s 不够。提升到 30s 让 e2e 在 coverage 模式下不超时
    hookTimeout: 30000,
    teardownTimeout: 30000,
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
    // 覆盖率默认配置：--coverage 时无需手传 CLI 参数
    // - 排除测试文件本身、e2e、类型声明、入口 barrel
    // - 单元测试（不含 e2e）即可驱动主要业务代码覆盖率
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.e2e.test.ts',
        'src/**/*.d.ts',
        // barrel 文件仅 re-export，无业务逻辑
        'src/index.ts',
      ],
      reporter: ['text', 'json', 'html'],
      reportsDirectory: './coverage',
      // 不因覆盖率失败（避免 CI 因 e2e 超时连锁失败）
      thresholds: undefined,
    },
  },
});
