import path from 'node:path';
import fs from 'node:fs';
import { importWithCacheBust } from '../utils/importWithCacheBust';
import type { FaapiConfig } from './configTypes';

/**
 * 配置产物文件名（compileConfig 生成）
 */
const CONFIG_PRODUCT_FILE = 'faapi-config.js';

/**
 * 加载 faapi 配置文件
 *
 * 统一读取 `<dist>/faapi-config.js` 产物：
 * - dev 模式：`faapi dev` 启动时由 `compileConfig` 生成 `.faapi/faapi-config.js`
 * - prod 模式：`faapi build` 时由 `compileConfig` 生成 `dist/faapi-config.js`
 *
 * 产物由 `compileConfig` 在构建阶段合并 env 后固化，运行时不读源码、不现场编译、不按 env 合并。
 *
 * - 产物存在 → import 并返回 default
 * - 产物不存在但源码有配置文件 → 抛错（强制 rebuild）
 * - 源码也无配置文件 → 返回 `null`（配置可选）
 *
 * @param rootDir 项目根目录
 * @param dist 产物目录（如 'dist' 或 '.faapi'）
 * @returns 配置对象，无配置文件时返回 null
 */
export async function loadConfig(
  rootDir: string,
  dist: string,
): Promise<Partial<FaapiConfig> | null> {
  const configProductPath = path.resolve(rootDir, dist, CONFIG_PRODUCT_FILE);

  if (fs.existsSync(configProductPath)) {
    const module = (await importWithCacheBust(configProductPath)) as {
      default?: Partial<FaapiConfig>;
    };
    return module.default ?? {};
  }

  // 产物不存在：检查源码是否有配置文件
  const hasSourceConfig =
    fs.existsSync(path.join(rootDir, 'faapi.config.ts')) ||
    fs.existsSync(path.join(rootDir, 'faapi.config.js'));

  if (hasSourceConfig) {
    throw new Error(
      `[faapi] ${dist}/${CONFIG_PRODUCT_FILE} 不存在，请先执行 \`faapi build\`（或 \`faapi dev\`）生成产物。`,
    );
  }

  return null;
}
