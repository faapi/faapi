#!/usr/bin/env node
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

// 注册 tsx，让 dev 模式下 import('.ts') 能正常加载用户路由文件
register('tsx/esm', pathToFileURL('./'));

// 动态 import 确保 tsx 注册在模块加载之前完成
import('./startCommand.js')
  .then(({ startCommand }) => startCommand(process.argv.slice(2)))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
