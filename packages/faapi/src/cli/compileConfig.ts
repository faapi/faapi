import path from 'node:path';
import fs from 'node:fs';
import { DEEP_MERGE_SOURCE } from '../config/deepMerge';

/**
 * 基础配置文件查找顺序（与 loadConfig 保持一致）
 */
const BASE_CONFIG_FILES = ['faapi.config.ts', 'faapi.config.js'];

/**
 * 环境配置文件后缀（与 loadConfig 保持一致）
 */
const ENV_CONFIG_EXTS = ['.ts', '.js'];

/**
 * 获取当前构建环境（用于查找 faapi.config.{env}.ts）
 *
 * 优先级：FAAPI_ENV → NODE_ENV → 'development'
 *
 * 与 loadConfig.getEnv 保持一致：build 时按相同规则确定 env，确保 build 产物与 dev 行为一致。
 */
function getEnv(): string {
  return process.env.FAAPI_ENV || process.env.NODE_ENV || 'development';
}

/**
 * 查找基础配置文件（返回相对 rootDir 的路径，无后缀，供 esbuild 解析）
 *
 * 返回相对路径而非绝对路径，是因为 esbuild stdin 入口的 resolveDir 设为 rootDir，
 * import 路径写相对路径（如 './faapi.config'），让 esbuild 自动解析后缀。
 */
function findBaseConfig(rootDir: string): string | null {
  for (const f of BASE_CONFIG_FILES) {
    if (fs.existsSync(path.join(rootDir, f))) {
      // 去掉后缀，让 esbuild 自动解析（与项目约定一致：相对 import 不写后缀）
      return f.replace(/\.(ts|js)$/, '');
    }
  }
  return null;
}

/**
 * 查找环境配置文件（返回相对 rootDir 的路径，无后缀）
 */
function findEnvConfig(rootDir: string, env: string): string | null {
  for (const ext of ENV_CONFIG_EXTS) {
    const f = `faapi.config.${env}${ext}`;
    if (fs.existsSync(path.join(rootDir, f))) {
      return `faapi.config.${env}`;
    }
  }
  return null;
}

export interface CompileConfigOptions {
  /** 项目根目录 */
  rootDir: string;
  /** 输出目录（如 dist） */
  outDir: string;
}

export interface CompileConfigResult {
  /** 是否生成了配置产物（无基础配置文件时不生成） */
  generated: boolean;
  /** 输出文件绝对路径（generated=false 时为空字符串） */
  outputFile: string;
}

/**
 * build 时编译并合并配置文件，生成 `dist/faapi-config.js`
 *
 * 流程：
 * 1. 查找基础配置 `faapi.config.ts`/`faapi.config.js`（无则跳过，不生成产物）
 * 2. 按 `FAAPI_ENV`/`NODE_ENV` 查找环境配置 `faapi.config.{env}.ts`
 * 3. 生成 esbuild 虚拟入口源码（import 两个配置 + 内联 deepMerge + export default 合并结果）
 * 4. esbuild bundle 编译为单个 `dist/faapi-config.js`（自包含，第三方依赖 external）
 *
 * 产物 `dist/faapi-config.js` 由 `loadConfig` 在 prod 模式直接 import，运行时无需现场编译、
 * 无需读源码 `.ts`、无需 `process.env.NODE_ENV` 决定合并——env 已在 build 阶段固化。
 *
 * 配置文件中的 `process.env.*` 表达式保留（不传 define），运行时读取环境变量。
 * 这与 `loadConfig.compileConfigFile` 行为一致：build 不固化运行时环境值。
 *
 * deepMerge 逻辑：通过 `DEEP_MERGE_SOURCE`（由 `deepMerge.toString()` 序列化）内联到入口源码，
 * 确保与 `loadConfig.deepMerge` 运行时实现完全一致。
 */
export async function compileConfig(options: CompileConfigOptions): Promise<CompileConfigResult> {
  const { rootDir, outDir } = options;

  const baseConfig = findBaseConfig(rootDir);
  if (!baseConfig) {
    // 无基础配置文件：不生成产物，loadConfig 会返回 null
    return { generated: false, outputFile: '' };
  }

  const env = getEnv();
  const envConfig = findEnvConfig(rootDir, env);

  // 生成入口源码：import 配置 + 内联 deepMerge + export 合并结果
  const imports: string[] = [`import base from './${baseConfig}';`];
  let exportDefault: string;

  if (envConfig) {
    imports.push(`import env from './${envConfig}';`);
    exportDefault = 'export default deepMerge(base, env);';
  } else {
    // 无环境配置：直接导出基础配置
    exportDefault = 'export default base;';
  }

  const entryCode = [...imports, DEEP_MERGE_SOURCE, exportDefault].join('\n');

  const outputFile = path.resolve(rootDir, outDir, 'faapi-config.js');
  await fs.promises.mkdir(path.dirname(outputFile), { recursive: true });

  const esbuild = await import('esbuild');
  await esbuild.build({
    stdin: { contents: entryCode, resolveDir: rootDir, loader: 'ts' },
    outfile: outputFile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    sourcemap: true,
    packages: 'external',
    logLevel: 'silent',
  });

  return { generated: true, outputFile };
}
