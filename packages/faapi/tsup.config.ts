import { defineConfig } from 'tsup';

export default defineConfig([
  // 运行时入口：保持外部依赖
  // 运行时入口：保持外部依赖
  // workerEntry 是任务隔离 worker 的真实入口文件，必须与 index.js 平铺同目录
  // （taskWorker.ts 按 import.meta.url 同级解析），对象形式入口强制输出到根
  {
    entry: {
      index: 'src/index.ts',
      testing: 'src/testing.ts',
      workerEntry: 'src/task/workerEntry.ts',
    },
    format: ['esm'],
    dts: true,
    clean: true,
    splitting: false,
    sourcemap: true,
    platform: 'node',
    external: ['node:*', 'typescript'],
  },
  // CLI 入口：打包 CLI 专用依赖，输出到 dist/cli/
  {
    entry: ['src/cli/index.ts'],
    outDir: 'dist/cli',
    format: ['esm'],
    dts: false,
    clean: true,
    splitting: false,
    sourcemap: true,
    platform: 'node',
    // 仅外部化运行时已有的依赖 + Node 内置模块
    // cac / chokidar 由 tsup 打包进 CLI 产物
    // esbuild 外部化：动态 import('esbuild')，打包进 ESM 后 CJS require('fs') 在 ESM 下报错
    external: ['node:*', 'typescript', 'fast-glob', 'ws', 'esbuild'],
  },
]);
