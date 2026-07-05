import { defineConfig } from 'tsup';

export default defineConfig([
  // 运行时入口：保持外部依赖
  {
    entry: ['src/index.ts'],
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
