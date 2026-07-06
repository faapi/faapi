#!/usr/bin/env node

import { cac } from 'cac';

const cli = cac('faapi');

cli
  .command('')
  .alias('dev')
  .action(async () => {
    const { devCommand } = await import('./devCommand.js');
    await devCommand();
  });

cli.command('build', 'Build for production').action(async () => {
  const { buildCommand } = await import('./buildCommand.js');
  await buildCommand();
});

cli.help();
cli.parse();
