import { cac } from 'cac';
import { normalizePatterns } from './normalizePatterns';

export interface CliArgs {
  patterns: string[];
  port: number;
  appDir: string;
  cors: boolean;
  staticDir?: string;
  types?: string;
  config?: string;
}

/**
 * 解析 CLI 参数
 * 支持：
 * - faapi
 * - faapi dev
 * - faapi api/auth/*
 * - faapi api/auth/*,api/novel/*
 * - faapi --port 3000 api/auth/*
 * - faapi --app-dir src api/auth/*
 *
 * 端口优先级：--port > PORT 环境变量 > 默认 3000
 */
export function parseArgs(argv: string[]): CliArgs {
  const cli = cac('faapi');

  cli
    .option('--port <port>', 'Server port (env: PORT)')
    .option('--app-dir <dir>', 'App directory (root by default)', { default: '.' })
    .option('--cors', 'Enable CORS (default in dev mode)')
    .option('--no-cors', 'Disable CORS')
    .option('--static <dir>', 'Static files directory', { default: undefined })
    .option('--no-static', 'Disable static file serving')
    .option('--types <path>', 'Output path for generated types file')
    .option('--config <path>', 'Path to config file (faapi.config.ts)');

  const { args, options } = cli.parse(['', '', ...argv]);

  // 过滤掉 'dev' 命令词
  const rawPatterns = args.map(String).filter((a) => a !== 'dev');
  const patterns = normalizePatterns(rawPatterns);

  // 端口优先级：--port > PORT 环境变量 > 3000
  const port = options.port ? Number(options.port) : Number(process.env.PORT) || 3000;

  const appDir = String(options.appDir ?? '.');

  // CORS: --no-cors 显式禁用，否则默认启用（dev 模式）
  const cors = options.cors !== false;

  // Static: --no-static 显式禁用，--static <dir> 指定目录
  const staticDir: string | undefined =
    options.static === false ? undefined : (options.static as string | undefined);

  // 默认扫描 <appDir>/api/**/*.ts（appDir='.' 时为 api/**/*.ts）
  const defaultPattern = appDir === '.' ? 'api/**/*.ts' : `${appDir}/api/**/*.ts`;

  return {
    patterns: patterns.length > 0 ? patterns : [defaultPattern],
    port,
    appDir,
    cors,
    staticDir,
    types: options.types as string | undefined,
    config: options.config as string | undefined,
  };
}
