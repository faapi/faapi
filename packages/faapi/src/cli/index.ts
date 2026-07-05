#!/usr/bin/env node

/**
 * CLI 入口：分发 dev / build 命令
 *
 * 路由文件由 esbuild 编译为 .js 产物（.faapi/dev/ 或 dist/），运行时不 import .ts。
 * faapi.config.ts 由 compileConfig 编译合并为 faapi-config.js 产物，运行时 loadConfig 直接 import。
 *
 * 命令分发：
 * - faapi build → buildCommand（bundle 编译到 dist/ + 生成产物三元组 + 生成 dist/main.js 启动入口）
 * - faapi / faapi dev → devCommand（编译到 .faapi/dev/ + 调 createDevApp 启动 dev 应用 + 启动 watcher）
 *
 * 配置（appDir、types、port 等）统一从 faapi.config.ts 读取，不再通过 CLI 选项传入。
 *
 * 框架采用零入口设计——用户无需编写 main.ts：
 * - dev：`faapi dev` 内部调 `createDevApp()` + `listen()`
 * - prod：`faapi build` 生成 `dist/main.js` 启动入口，`node dist/main` 直接启动服务
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const firstArg = argv[0];

  if (firstArg === 'build') {
    const { buildCommand } = await import('./buildCommand.js');
    await buildCommand();
    return;
  }

  const { devCommand } = await import('./devCommand.js');
  await devCommand();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
