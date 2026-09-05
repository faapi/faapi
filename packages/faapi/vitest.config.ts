import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
    // 文件级并行 + fork 池上限 2。
    // 历史：CI 曾因资源紧张串行化（fileParallelism:false + maxWorkers:1 + singleFork，
    // 见 a3f7014/dcb7827，症状含 OOM 与 fork 子进程 ERR_IPC_CHANNEL_CLOSED——后者是
    // 内存压力下子进程被杀的表现），当时还在 fork 子进程设过 8GB 堆上限。
    // 两者均已随条件解除而移除：CI 按包拆 matrix（每 job 独占 4 vCPU / 16 GB runner，
    // 包间内存竞争消除）；forks 池默认 isolation——每个测试文件独立子进程、跑完即退，
    // 单文件堆工作集远低于 V8 默认 4GB 上限（8GB 防御针对的是 singleFork 单进程
    // 累计全部文件的场景）。maxWorkers:2 理论堆上限 2×4=8GB，远离物理内存。
    maxWorkers: 2,
    pool: 'forks',
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
