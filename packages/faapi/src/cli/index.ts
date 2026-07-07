#!/usr/bin/env node

import { cac } from 'cac';

const cli = cac('faapi');

cli
  .command('')
  .alias('dev')
  .option('--port <number>', '服务端口（默认 3000）')
  .option('--dist <dir>', '产物根目录（默认 .faapi，dev 产物输出到 <dist>/dev）')
  .action(async (options) => {
    const { devCommand } = await import('./devCommand.js');
    await devCommand(options);
  });

cli
  .command('build', 'Build for production')
  .option('--port <number>', 'prod 服务端口，写入 <dist>/build/main.js')
  .option('--dist <dir>', '产物根目录（默认 .faapi，prod 产物输出到 <dist>/build）')
  .action(async (options) => {
    const { buildCommand } = await import('./buildCommand.js');
    await buildCommand(options);
  });

cli.help();
cli.parse();
