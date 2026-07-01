#!/usr/bin/env node

/**
 * 检测 tsx 是否已通过 `node --import tsx` 预加载
 * 已预加载时跳过 register：register('tsx/esm') 与 --import tsx 同存会触发 Node 24 ERR_REQUIRE_CYCLE_MODULE
 */
function isTsxPreloaded(): boolean {
  return (
    process.execArgv.some((arg) => arg.includes('tsx')) ||
    (process.env.NODE_OPTIONS ?? '').includes('tsx')
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // 顶层命令分发：build 独立分支，不进 startCommand
  // dev/start 都走 startCommand，由 mode 区分
  const firstArg = argv.find((a) => !a.startsWith('-'));
  if (firstArg === 'build') {
    const { parseBuildArgs, buildCommand } = await import('./buildCommand.js');
    const options = parseBuildArgs(argv.filter((a) => a !== 'build'));
    await buildCommand(options);
    return;
  }

  // dev 模式（非 start）需要 tsx 来加载用户 .ts 路由文件
  // start 模式加载的是 dist 下的 .js，无需 tsx
  const isStartMode = firstArg === 'start';
  if (!isStartMode && !isTsxPreloaded()) {
    // tsx/esm/api 的 register() 内部自动构造 MessageChannel 传给 module.register，
    // 满足 tsx 4.22+ initialize 钩子要求
    try {
      const { register } = await import('tsx/esm/api');
      register();
    } catch (err) {
      console.error('[faapi] tsx 加载失败，请确认已安装 tsx：', err);
      process.exit(1);
    }
  }

  // tsx 注册（如需）完成后，再加载 startCommand（它可能 import 用户 .ts 路由）
  const { startCommand } = await import('./startCommand.js');
  await startCommand(argv);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
