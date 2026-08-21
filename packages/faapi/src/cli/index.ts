#!/usr/bin/env node

import { cac } from 'cac';

/**
 * 创建 faapi CLI 实例（导出供测试调用 `cli.parse(argv)` 显式传参）。
 *
 * cac 在模块加载时捕获 `process.argv` 快照（`const processArgs = process.argv`），
 * `cli.parse()` 无参时用该快照。生产环境 CLI 入口由 shebang 触发，`process.argv` 已就绪；
 * 测试环境需显式传 argv 才能精确控制命令分发。
 */
export function createCli() {
  const cli = cac('faapi');

  cli
    .command('')
    .alias('dev')
    .option('--port <number>', '服务端口（默认 3000）')
    .action(async (options) => {
      const { devCommand } = await import('./devCommand.js');
      await devCommand(options);
    });

  cli
    .command('build', 'Build for production')
    .option('--dist <dir>', '产物输出目录，默认 dist')
    .action(async (options) => {
      const { buildCommand } = await import('./buildCommand.js');
      await buildCommand(options);
    });

  cli.help();
  return cli;
}

// shebang 入口：直接执行时 parse（用 process.argv 快照）
createCli().parse();
