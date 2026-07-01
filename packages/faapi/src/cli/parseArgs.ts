import { cac } from 'cac';
import { normalizePatterns } from './normalizePatterns';

export type CliMode = 'dev' | 'start';

export interface CliArgs {
  /** 启动模式：dev=开发模式（加载 .ts），start=生产模式（加载 dist/*.js） */
  mode: CliMode;
  patterns: string[];
  port: number;
  appDir: string;
  cors: boolean;
  staticDir?: string;
  types?: string;
  config?: string;
}

/** 命令词 → mode 映射 */
const COMMAND_MODES: Record<string, CliMode> = {
  dev: 'dev',
  start: 'start',
};

/**
 * 解析 CLI 参数
 * 支持：
 * - faapi              # dev 模式，扫描 src/api 下的 .ts
 * - faapi dev          # 同上
 * - faapi start        # prd 模式，加载 dist 下的 .js（需先 faapi build）
 * - faapi api/auth/    # 指定 patterns
 * - faapi --port 3000 api/auth/
 * - faapi --app-dir . api/auth/    # 显式回退到项目根目录
 *
 * 端口优先级：--port > PORT 环境变量 > 默认 3000
 */
export function parseArgs(argv: string[]): CliArgs {
  const cli = cac('faapi');

  cli
    .option('--port <port>', 'Server port (env: PORT)')
    .option('--app-dir <dir>', 'App directory (src by default)', { default: 'src' })
    .option('--cors', 'Enable CORS (default in dev mode)')
    .option('--no-cors', 'Disable CORS')
    .option('--static <dir>', 'Static files directory', { default: undefined })
    .option('--no-static', 'Disable static file serving')
    .option('--types <path>', 'Output path for generated types file')
    .option('--config <path>', 'Path to config file (faapi.config.ts)');

  const { args, options } = cli.parse(['', '', ...argv]);

  // 第一个非命令词的位置参数为 patterns，其余为命令词
  // 命令词仅 dev/start，其他词（如 'build'）由上层 cli/index.ts 分发，不进 parseArgs
  let mode: CliMode = 'dev';
  const rawPatterns: string[] = [];
  for (const arg of args) {
    const str = String(arg);
    if (str in COMMAND_MODES) {
      mode = COMMAND_MODES[str];
    } else {
      rawPatterns.push(str);
    }
  }
  const patterns = normalizePatterns(rawPatterns);

  // 端口优先级：--port > PORT 环境变量 > 3000
  const port = options.port ? Number(options.port) : Number(process.env.PORT) || 3000;

  const appDir = String(options.appDir ?? 'src');

  // CORS: --no-cors 显式禁用，否则默认启用
  const cors = options.cors !== false;

  // Static: --no-static 显式禁用，--static <dir> 指定目录
  const staticDir: string | undefined =
    options.static === false ? undefined : (options.static as string | undefined);

  // 默认扫描 patterns
  // dev 模式：扫描 <appDir>/api/**/*.ts（--app-dir . 时为 api/**/*.ts）
  // start 模式：加载 dist 下的 .js，由 startCommand.adjustForProd 调整
  const defaultPattern = appDir === '.' ? 'api/**/*.ts' : `${appDir}/api/**/*.ts`;

  return {
    mode,
    patterns: patterns.length > 0 ? patterns : [defaultPattern],
    port,
    appDir,
    cors,
    staticDir,
    types: options.types as string | undefined,
    config: options.config as string | undefined,
  };
}
