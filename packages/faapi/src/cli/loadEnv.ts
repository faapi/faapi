import fs from 'node:fs';
import path from 'node:path';

/**
 * env 决定规则：NODE_ENV || 'development'
 *
 * 调用方应在调 loadEnv 之前自行兜底 NODE_ENV（dev 设 'development'，prod 设 'production'）。
 */
function resolveEnv(): string {
  return process.env.NODE_ENV || 'development';
}

/**
 * .env 文件加载顺序（从低到高优先级，后加载的覆盖先加载的）
 *
 * 1. .env — 所有环境共享
 * 2. .env.local — 本地覆盖（不提交 git）
 * 3. .env.{env} — 按环境覆盖
 * 4. .env.{env}.local — 按环境本地覆盖
 */
function getEnvFiles(env: string): string[] {
  return ['.env', '.env.local', `.env.${env}`, `.env.${env}.local`];
}

/**
 * 解析 .env 文件内容为键值对象
 *
 * 格式：
 * - `KEY=VALUE` 基本格式
 * - `# 注释` 行首注释
 * - `export KEY=VALUE` 支持 export 前缀
 * - 单引号：字面量，不展开变量，不处理转义
 * - 双引号：支持变量展开（$VAR / ${VAR}）和转义（\n \t \r \\ \"）
 * - 无引号：字面量，` #` 后为行内注释
 *
 * @param content .env 文件内容
 * @param fileVars 本文件之前已解析的变量（用于变量展开）
 * @returns 解析出的键值对象
 */
function parseEnvFile(content: string, fileVars: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  // 兼容 CRLF / LF
  const lines = content.replace(/\r\n/g, '\n').split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    // 空行 / 注释行跳过
    if (!trimmed || trimmed.startsWith('#')) continue;

    // 匹配 KEY=VALUE 或 export KEY=VALUE
    // KEY 必须符合 [A-Za-z_][A-Za-z0-9_]*
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    if (!match) continue;

    const [, key, rawValue] = match;
    const value = parseValue(rawValue, { ...fileVars, ...result });
    result[key] = value;
  }

  return result;
}

/**
 * 解析单个值的引号/展开/转义
 *
 * - 单引号：字面量（去除首尾单引号）
 * - 双引号：处理转义 + 展开变量
 * - 无引号：字面量，去除行内注释（` #` 后为注释）
 */
function parseValue(raw: string, env: Record<string, string>): string {
  if (raw === '') return '';

  // 单引号：字面量
  if (raw[0] === "'") {
    const end = raw.indexOf("'", 1);
    return end === -1 ? raw.slice(1) : raw.slice(1, end);
  }

  // 双引号：转义 + 展开变量（支持 \" 转义引号，不作为结束符）
  if (raw[0] === '"') {
    const match = /^"((?:\\.|[^"\\])*)"/.exec(raw);
    const inner = match ? match[1] : raw.slice(1);
    return expandEscapesAndVars(inner, env);
  }

  // 无引号：字面量，处理行内注释
  // ` #` 前必须有空白才算注释；# 紧贴值（如 url#anchor）不算注释
  const commentMatch = /^(.*?)(\s+#.*)$/.exec(raw);
  const value = commentMatch ? commentMatch[1] : raw;
  return value.trim();
}

/**
 * 双引号值：处理转义字符 + 展开变量
 *
 * 转义：\n \r \t \\ \" （未知转义保留字符本身）
 * 展开：$VAR / ${VAR}，优先 env 参数，其次 process.env，未定义返回空字符串
 */
function expandEscapesAndVars(str: string, env: Record<string, string>): string {
  // 先处理转义（避免变量值中的 $ 被二次展开）
  const escaped = str.replace(/\\(.)/g, (_, ch: string) => {
    switch (ch) {
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      case '\\':
        return '\\';
      case '"':
        return '"';
      default:
        return ch; // 未知转义保留字符
    }
  });

  // 展开变量：$VAR 或 ${VAR}
  return escaped.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (_, braced, plain) => {
      const varName = braced || plain;
      return env[varName] ?? process.env[varName] ?? '';
    },
  );
}

/**
 * 加载 `.env` 系列文件到 `process.env`
 *
 * 按 Next.js 约定加载四级文件（从低到高）：
 * 1. `.env` — 所有环境共享
 * 2. `.env.local` — 本地覆盖
 * 3. `.env.{env}` — 按环境覆盖
 * 4. `.env.{env}.local` — 按环境本地覆盖
 *
 * env 由 `NODE_ENV || 'development'` 决定。调用方应在调 loadEnv 之前自行兜底 NODE_ENV
 * （dev 设 'development'，prod 设 'production'）。
 *
 * 合并规则：
 * - 后加载的文件覆盖先加载的同名变量
 * - **shell 已设置的变量不被覆盖**（`process.env` 已有的值优先）
 *
 * @param rootDir 项目根目录（`.env` 文件所在目录）
 */
export function loadEnv(rootDir: string): void {
  const env = resolveEnv();
  const files = getEnvFiles(env);

  // 收集所有文件解析结果，按优先级合并（后面的覆盖前面的）
  const merged: Record<string, string> = {};
  for (const file of files) {
    const filePath = path.join(rootDir, file);
    if (!fs.existsSync(filePath)) continue;
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = parseEnvFile(content, merged);
    Object.assign(merged, parsed);
  }

  // 写入 process.env（不覆盖已有的 shell 变量）
  for (const [key, value] of Object.entries(merged)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
