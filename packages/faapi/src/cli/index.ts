#!/usr/bin/env node

/**
 * CLI 入口：分发 dev / start / build 命令
 *
 * 路由文件由 esbuild 编译为 .js 产物（.faapi/dev/ 或 dist/），运行时不 import .ts。
 * faapi.config.ts 由 loadConfig 用 esbuild 编译为临时 .mjs 后 import，无需 tsx。
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // 顶层命令分发：build 独立分支，不进 startCommand
  // dev/start 都走 startCommand，由 mode 区分
  const firstArg = argv.find((a) => !a.startsWith('-'));

  // 命令分发
  if (firstArg === 'build') {
    const { parseBuildArgs, buildCommand } = await import('./buildCommand.js');
    const options = parseBuildArgs(argv.filter((a) => a !== 'build'));
    await buildCommand(options);
    return;
  }

  const { startCommand } = await import('./startCommand.js');
  await startCommand(argv);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
