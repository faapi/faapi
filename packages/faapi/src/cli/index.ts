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

/**
 * 注册 tsx（用于加载 faapi.config.ts 等用户 .ts 配置文件）
 *
 * 新架构下路由文件由 esbuild 编译为 .js 产物，不再需要 tsx 即时转译。
 * 但 faapi.config.ts 仍由 loadConfig 直接 import，需要 tsx 处理 .ts。
 *
 * tsx 只影响 .ts 文件的 import，.js 文件不受影响（dev/start 加载的路由产物是 .js）。
 *
 * @returns true 表示 tsx 已就绪（已注册或预加载），false 表示不可用
 */
async function ensureTsx(): Promise<boolean> {
  if (isTsxPreloaded()) return true;
  try {
    const { register } = await import('tsx/esm/api');
    register();
    return true;
  } catch {
    // tsx 未安装：faapi.config.ts 无法加载，但 faapi.config.js 仍可用
    console.warn(
      '[faapi] tsx 未安装，无法加载 faapi.config.ts。请安装 tsx 或使用 faapi.config.js。',
    );
    return false;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // 顶层命令分发：build 独立分支，不进 startCommand
  // dev/start 都走 startCommand，由 mode 区分
  const firstArg = argv.find((a) => !a.startsWith('-'));
  const isBuildMode = firstArg === 'build';

  // build 模式不需要 tsx（不加载 faapi.config.ts，路由由 esbuild 编译）
  // dev/start 模式需要 tsx 加载 faapi.config.ts（路由走 esbuild 产物，不需要 tsx）
  if (!isBuildMode) {
    await ensureTsx();
  }

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
