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
    // tsx 外部化：dev 模式下从用户 node_modules 解析，避免 tsx+esbuild 被打包进 ESM 后
    // esbuild 的 CJS require('fs') 在 ESM 下报错；prd 模式不引用 tsx，tree-shake 掉
    // esbuild 外部化：build 命令动态 import('esbuild')，打包进 ESM 后同样报 CJS require 错
    external: ['node:*', 'typescript', 'fast-glob', 'ws', '@faapi/schema', 'tsx', 'esbuild'],
  },
]);
