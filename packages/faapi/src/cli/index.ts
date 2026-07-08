#!/usr/bin/env node

import { cac } from 'cac';

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
cli.parse();
