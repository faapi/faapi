import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { importWithCacheBust } from '../utils/importWithCacheBust';
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
 *
 * - `.js` / `.mjs`：直接 import
 * - `.ts`：用 esbuild 编译为临时 `.mjs` 后 import（替代 tsx register）
 *
 * `.ts` 编译产物写入系统临时目录（每次启动唯一子目录），避免污染用户项目。
 * 第三方依赖与 `@faapi/*` 保持 external，从用户 node_modules 解析。
 */
async function loadConfigFile(filePath: string): Promise<Partial<FaapiConfig> | null> {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    let modulePath = filePath;
    if (filePath.endsWith('.ts')) {
      modulePath = await compileConfigFile(filePath);
    }
    const module = (await importWithCacheBust(modulePath)) as {
      default?: Partial<FaapiConfig>;
    };
    return module.default ?? {};
  } catch (err) {
    throw new Error(
      `Failed to load config file ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

/**
 * 用 esbuild 编译单个 `.ts` 配置文件为 `.mjs` 临时文件
 *
 * - `bundle: true`：跟随 import 链，本地相对导入会被打包进来
 * - 第三方依赖与 `@faapi/*` 保持 external，从用户 node_modules 解析
 * - 产物路径基于源文件内容哈希，避免重复编译（同一文件多次加载复用产物）
 *
 * @returns 编译后的 `.mjs` 文件绝对路径
 */
async function compileConfigFile(tsPath: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  const content = await fs.promises.readFile(tsPath, 'utf8');
  const hash = createHash('sha1').update(content).digest('hex').slice(0, 12);
  const tmpDir = path.join(os.tmpdir(), 'faapi-config');
  await fs.promises.mkdir(tmpDir, { recursive: true });
  const outFile = path.join(tmpDir, `config-${hash}.mjs`);

  // 内容未变化时跳过编译（同一进程多次加载同一配置文件）
  if (fs.existsSync(outFile)) {
    return outFile;
  }

  const esbuild = await import('esbuild');
  await esbuild.build({
    entryPoints: [tsPath],
    outfile: outFile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    sourcemap: true,
    packages: 'external',
    logLevel: 'silent',
  });
  return outFile;
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
