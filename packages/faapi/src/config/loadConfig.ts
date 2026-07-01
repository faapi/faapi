import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { FaapiConfig } from './configTypes';

/**
 * 配置文件查找顺序
 *
 * 1. faapi.config.ts / faapi.config.js（基础配置）
 * 2. faapi.config.{env}.ts / faapi.config.{env}.js（环境覆盖）
 *
 * 环境覆盖深度合并到基础配置上（见 deepMerge）
 */
const BASE_CONFIG_FILES = ['faapi.config.ts', 'faapi.config.js'];

/**
 * 获取当前运行环境（用于加载 faapi.config.{env}.ts）
 *
 * 优先级：FAAPI_ENV → NODE_ENV → 'development'
 *
 * FAAPI_ENV 优先：让 faapi 的环境切换不污染全局 NODE_ENV（其他库也读 NODE_ENV）。
 * FAAPI_ENV 未设时回退 NODE_ENV，符合 Node 生态默认直觉。
 */
function getEnv(): string {
  return process.env.FAAPI_ENV || process.env.NODE_ENV || 'development';
}

/**
 * 深度合并两个配置对象（后者覆盖前者）
 *
 * 特殊对象（Date / RegExp / Map / Set）直接替换，不递归合并。
 */
export function deepMerge<T extends Record<string, unknown>>(
  base: T,
  override: Record<string, unknown>,
): T {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    const baseVal = (base as Record<string, unknown>)[key];
    const overVal = override[key];

    // 特殊对象类型直接替换（不递归合并）
    if (
      baseVal instanceof Date ||
      overVal instanceof Date ||
      baseVal instanceof RegExp ||
      overVal instanceof RegExp ||
      baseVal instanceof Map ||
      overVal instanceof Map ||
      baseVal instanceof Set ||
      overVal instanceof Set
    ) {
      (result as Record<string, unknown>)[key] = overVal;
      continue;
    }

    // 普通对象递归合并
    if (
      baseVal !== null &&
      overVal !== null &&
      typeof baseVal === 'object' &&
      typeof overVal === 'object' &&
      !Array.isArray(baseVal) &&
      !Array.isArray(overVal) &&
      !(baseVal instanceof Function) &&
      !(overVal instanceof Function)
    ) {
      (result as Record<string, unknown>)[key] = deepMerge(
        baseVal as Record<string, unknown>,
        overVal as Record<string, unknown>,
      );
    } else {
      (result as Record<string, unknown>)[key] = overVal;
    }
  }
  return result;
}

/**
 * 加载单个配置文件
 */
async function loadConfigFile(filePath: string): Promise<Partial<FaapiConfig> | null> {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const url = pathToFileURL(filePath).href;
    const module = (await import(url)) as { default?: Partial<FaapiConfig> };
    return module.default ?? {};
  } catch (err) {
    throw new Error(
      `Failed to load config file ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

/**
 * 加载 faapi 配置文件
 *
 * 查找顺序：
 * 1. 指定的 configPath
 * 2. faapi.config.ts / faapi.config.js（基础配置）
 * 3. faapi.config.{env}.ts / faapi.config.{env}.js（环境覆盖，深度合并）
 *
 * 环境由 FAAPI_ENV 或 NODE_ENV 决定，默认 'development'
 *
 * @param rootDir 项目根目录
 * @param configPath 指定的配置文件路径（可选）
 * @returns 合并后的配置，如果无配置文件则返回 null
 */
export async function loadConfig(
  rootDir: string,
  configPath?: string,
): Promise<Partial<FaapiConfig> | null> {
  // 指定了配置文件路径时，直接加载该文件（文件不存在则抛错）
  if (configPath) {
    const resolvedPath = path.resolve(rootDir, configPath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Config file not found: ${configPath}`);
    }
    return loadConfigFile(resolvedPath);
  }

  // 查找基础配置文件
  let baseConfig: Partial<FaapiConfig> | null = null;
  for (const fileName of BASE_CONFIG_FILES) {
    const filePath = path.join(rootDir, fileName);
    baseConfig = await loadConfigFile(filePath);
    if (baseConfig) break;
  }

  if (!baseConfig) {
    return null;
  }

  // 查找环境配置文件并合并
  const env = getEnv();
  const envFiles = [`faapi.config.${env}.ts`, `faapi.config.${env}.js`];

  for (const envFile of envFiles) {
    const envConfig = await loadConfigFile(path.join(rootDir, envFile));
    if (envConfig) {
      baseConfig = deepMerge(baseConfig, envConfig);
      break;
    }
  }

  return baseConfig;
}
