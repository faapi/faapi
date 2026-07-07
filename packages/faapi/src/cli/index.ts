#!/usr/bin/env node

import { cac } from 'cac';

const cli = cac('faapi');

cli
  .command('')
  .alias('dev')
  .option('--port <number>', '服务端口（默认 3000）')
  .option('--appDir <dir>', '源码目录前缀（默认 src）')
  .action(async (options) => {
    const { devCommand } = await import('./devCommand.js');
    await devCommand(options);
  });

cli
  .command('build', 'Build for production')
  .option('--port <number>', 'prod 服务端口，写入 dist/main.js')
  .option('--appDir <dir>', '源码目录前缀（默认 src）')
  .option('--outDir <dir>', '产物输出目录（默认 dist）')
  .action(async (options) => {
    const { buildCommand } = await import('./buildCommand.js');
    await buildCommand(options);
  });

cli.help();
cli.parse();
