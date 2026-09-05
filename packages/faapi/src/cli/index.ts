#!/usr/bin/env node

import { cac } from 'cac';
import { createRequire } from 'node:module';

/**
 * 从最近的 package.json 读版本号
 *
 * src/cli/index.ts 需向上两级到包根，dist/index.js 一级——逐级探测，
 * 命中第一个存在的 package.json（publishConfig 的 files 只发 dist，
 * 探测在 dist 内即命中包根）
 */
function resolveVersion(): string {
  const require = createRequire(import.meta.url);
  for (const rel of ['../package.json', '../../package.json']) {
    try {
      const { version } = require(rel) as { version: string };
      if (version) return version;
    } catch {
      // 继续向上一级探测
    }
  }
  return '0.0.0';
}

/**
 * 创建 faapi CLI 实例（导出供测试调用 `cli.parse(argv)` 显式传参）。
 *
 * cac 在模块加载时捕获 `process.argv` 快照（`const processArgs = process.argv`），
 * `cli.parse()` 无参时用该快照。生产环境 CLI 入口由 shebang 触发，`process.argv` 已就绪；
 * 测试环境需显式传 argv 才能精确控制命令分发。
 */
export function createCli() {
  const version = resolveVersion();

  const cli = cac('faapi');

  cli
    .command('')
    .alias('dev')
    .option('--port <number>', '服务端口（默认 3000）')
    .action(async (options) => {
      const { devCommand } = await import('./devCommand.js');
      await runCommand(() => devCommand(options));
    });

  cli
    .command('build', 'Build for production')
    .option('--dist <dir>', '产物输出目录，默认 dist')
    .action(async (options) => {
      const { buildCommand } = await import('./buildCommand.js');
      await runCommand(() => buildCommand(options));
    });

  cli.help();
  cli.version(version);
  return cli;
}

/**
 * 命令顶层错误处理：编译/配置/加载错误以一行友好摘要输出（exit code 1），
 * 不再裸堆栈糊屏。设置 FAAPI_DEBUG=1 时附加完整堆栈供排查。
 */
async function runCommand(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\nfaapi: ${message}`);
    if (process.env.FAAPI_DEBUG && err instanceof Error && err.stack) {
      console.error(err.stack);
    }
    process.exitCode = 1;
  }
}

// shebang 入口：直接执行时 parse（用 process.argv 快照）
createCli().parse();
