import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadEnv } from './loadEnv';

/**
 * loadEnv 测试：按 Next.js 约定加载 .env 系列文件
 *
 * 覆盖：
 * - 基础 .env 加载
 * - 文件优先级（.env < .env.local < .env.{env} < .env.{env}.local）
 * - shell 变量不被覆盖
 * - NODE_ENV 决定加载哪个 .env.{env} 文件
 * - .env 文件格式（注释、引号、变量展开、转义、export 前缀）
 * - 文件不存在时静默跳过
 * - 无引号值的行内注释
 */
describe('loadEnv', () => {
  let tempDir: string;
  const ENV_KEYS = [
    'NODE_ENV',
    'DB_HOST',
    'DB_PORT',
    'API_KEY',
    'SECRET',
    'BASE_URL',
    'SHARED',
    'OTHER',
    'BASE',
    'FULL_URL',
    'NESTED',
    'LITERAL',
    'NEWLINE',
    'TAB',
    'BACKSLASH',
    'QUOTE',
    'URL',
    'EMPTY',
    'ALSO_EMPTY',
    'OK',
    'GREETING',
    'BROKEN',
    'DERIVED',
    'UNDEFINED_VAR',
    'EXISTING',
  ];
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    tempDir = join(tmpdir(), `faapi-loadenv-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    // 保存所有测试用到的环境变量
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
    }
    // 清理 NODE_ENV，确保兜底 development 能生效（vitest 可能设置 NODE_ENV）
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    // 恢复环境变量
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  /** 写 .env 文件到 tempDir */
  function writeEnv(filename: string, content: string): void {
    writeFileSync(join(tempDir, filename), content, 'utf-8');
  }

  it('基础 .env 加载到 process.env', () => {
    writeEnv('.env', 'DB_HOST=localhost\nDB_PORT=5432\n');
    loadEnv(tempDir);
    expect(process.env.DB_HOST).toBe('localhost');
    expect(process.env.DB_PORT).toBe('5432');
  });

  it('无任何 .env 文件时不报错', () => {
    expect(() => loadEnv(tempDir)).not.toThrow();
  });

  it('文件优先级：.env.local 覆盖 .env', () => {
    writeEnv('.env', 'DB_HOST=localhost\nSHARED=from-base\n');
    writeEnv('.env.local', 'DB_HOST=from-local\n');
    loadEnv(tempDir);
    expect(process.env.DB_HOST).toBe('from-local');
    expect(process.env.SHARED).toBe('from-base');
  });

  it('文件优先级：.env.{env} 覆盖 .env.local', () => {
    process.env.NODE_ENV = 'production';
    writeEnv('.env', 'DB_HOST=localhost\n');
    writeEnv('.env.local', 'DB_HOST=from-local\n');
    writeEnv('.env.production', 'DB_HOST=from-prod\n');
    loadEnv(tempDir);
    expect(process.env.DB_HOST).toBe('from-prod');
  });

  it('文件优先级：.env.{env}.local 优先级最高', () => {
    process.env.NODE_ENV = 'production';
    writeEnv('.env', 'DB_HOST=localhost\n');
    writeEnv('.env.local', 'DB_HOST=from-local\n');
    writeEnv('.env.production', 'DB_HOST=from-prod\n');
    writeEnv('.env.production.local', 'DB_HOST=from-prod-local\n');
    loadEnv(tempDir);
    expect(process.env.DB_HOST).toBe('from-prod-local');
  });

  it('shell 已设置的变量不被 .env 覆盖', () => {
    process.env.DB_HOST = 'from-shell';
    writeEnv('.env', 'DB_HOST=from-file\nOTHER=loaded\n');
    loadEnv(tempDir);
    expect(process.env.DB_HOST).toBe('from-shell');
    expect(process.env.OTHER).toBe('loaded');
  });

  it('shell 已设置的变量不被后加载文件覆盖', () => {
    process.env.DB_HOST = 'from-shell';
    writeEnv('.env', 'DB_HOST=from-base\n');
    writeEnv('.env.local', 'DB_HOST=from-local\n');
    loadEnv(tempDir);
    expect(process.env.DB_HOST).toBe('from-shell');
  });

  it('NODE_ENV 决定加载哪个 .env.{env} 文件', () => {
    process.env.NODE_ENV = 'staging';
    writeEnv('.env.staging', 'DB_HOST=staging-host\n');
    loadEnv(tempDir);
    expect(process.env.DB_HOST).toBe('staging-host');
  });

  it('NODE_ENV 未设置时兜底 development', () => {
    delete process.env.NODE_ENV;
    writeEnv('.env.development', 'DB_HOST=dev-host\n');
    loadEnv(tempDir);
    expect(process.env.DB_HOST).toBe('dev-host');
  });

  // ===== .env 文件格式 =====

  it('忽略空行和注释行', () => {
    writeEnv('.env', '\n# 这是注释\nDB_HOST=localhost\n  # 带缩进的注释\nDB_PORT=5432\n');
    loadEnv(tempDir);
    expect(process.env.DB_HOST).toBe('localhost');
    expect(process.env.DB_PORT).toBe('5432');
  });

  it('支持 export 前缀', () => {
    writeEnv('.env', 'export DB_HOST=localhost\nexport API_KEY=secret\n');
    loadEnv(tempDir);
    expect(process.env.DB_HOST).toBe('localhost');
    expect(process.env.API_KEY).toBe('secret');
  });

  it('双引号支持变量展开', () => {
    writeEnv('.env', 'BASE=http://api\nFULL_URL="${BASE}/v1"\n');
    loadEnv(tempDir);
    expect(process.env.FULL_URL).toBe('http://api/v1');
  });

  it('双引号支持 ${VAR} 语法展开', () => {
    writeEnv('.env', 'BASE=http://api\nFULL_URL="${BASE}/v1"\nNESTED="${FULL_URL}/users"\n');
    loadEnv(tempDir);
    expect(process.env.FULL_URL).toBe('http://api/v1');
    expect(process.env.NESTED).toBe('http://api/v1/users');
  });

  it('双引号变量展开优先用已解析的 .env 变量', () => {
    process.env.BASE = 'from-shell';
    writeEnv('.env', 'BASE=from-file\nDERIVED="${BASE}/v1"\n');
    loadEnv(tempDir);
    // BASE 被 shell 设置，不被覆盖；但 DERIVED 展开用的是 .env 文件内的 BASE
    expect(process.env.BASE).toBe('from-shell');
    expect(process.env.DERIVED).toBe('from-file/v1');
  });

  it('单引号不展开变量', () => {
    writeEnv('.env', "LITERAL='${BASE}'\nBASE=http://api\n");
    loadEnv(tempDir);
    expect(process.env.LITERAL).toBe('${BASE}');
  });

  it('双引号支持转义字符', () => {
    writeEnv('.env', 'NEWLINE="line1\\nline2"\nTAB="a\\tb"\n');
    loadEnv(tempDir);
    expect(process.env.NEWLINE).toBe('line1\nline2');
    expect(process.env.TAB).toBe('a\tb');
  });

  it('双引号支持转义反斜杠和引号', () => {
    writeEnv('.env', 'BACKSLASH="a\\\\b"\nQUOTE="say \\"hi\\""\n');
    loadEnv(tempDir);
    expect(process.env.BACKSLASH).toBe('a\\b');
    expect(process.env.QUOTE).toBe('say "hi"');
  });

  it('无引号值：字面量，支持行内注释', () => {
    writeEnv('.env', 'DB_HOST=localhost # 行内注释\n');
    loadEnv(tempDir);
    expect(process.env.DB_HOST).toBe('localhost');
  });

  it('无引号值：# 紧贴值不算注释', () => {
    writeEnv('.env', 'URL=http://api#anchor\n');
    loadEnv(tempDir);
    expect(process.env.URL).toBe('http://api#anchor');
  });

  it('无引号值：去除首尾空格', () => {
    writeEnv('.env', 'DB_HOST=   localhost   \n');
    loadEnv(tempDir);
    expect(process.env.DB_HOST).toBe('localhost');
  });

  it('空值', () => {
    writeEnv('.env', 'EMPTY=\nALSO_EMPTY=""\n');
    loadEnv(tempDir);
    expect(process.env.EMPTY).toBe('');
    expect(process.env.ALSO_EMPTY).toBe('');
  });

  it('非法 KEY 行被跳过', () => {
    writeEnv('.env', '123BAD=value\nvalid-key=ok\n-dash=start\nOK=good\n');
    loadEnv(tempDir);
    expect(process.env.OK).toBe('good');
  });

  it('等号两边空格处理', () => {
    writeEnv('.env', 'DB_HOST  =  localhost  \n');
    loadEnv(tempDir);
    expect(process.env.DB_HOST).toBe('localhost');
  });

  it('多文件加载时变量展开跨文件生效', () => {
    writeEnv('.env', 'BASE=http://api\n');
    writeEnv('.env.local', 'FULL_URL="${BASE}/v1"\n');
    loadEnv(tempDir);
    expect(process.env.BASE).toBe('http://api');
    expect(process.env.FULL_URL).toBe('http://api/v1');
  });

  it('Windows 风格行尾（CRLF）兼容', () => {
    writeEnv('.env', 'DB_HOST=localhost\r\nDB_PORT=5432\r\n');
    loadEnv(tempDir);
    expect(process.env.DB_HOST).toBe('localhost');
    expect(process.env.DB_PORT).toBe('5432');
  });

  it('值为纯双引号字符串（含空格）', () => {
    writeEnv('.env', 'GREETING="hello world"\n');
    loadEnv(tempDir);
    expect(process.env.GREETING).toBe('hello world');
  });

  it('未闭合引号按字面量处理', () => {
    writeEnv('.env', 'BROKEN="unclosed\n');
    loadEnv(tempDir);
    // 未闭合双引号：取整个剩余行作为字面量（去掉引号前缀）
    expect(process.env.BROKEN).toBe('unclosed');
  });

  it('变量展开引用未定义变量返回空字符串', () => {
    writeEnv('.env', 'DERIVED="${UNDEFINED_VAR}/path"\n');
    loadEnv(tempDir);
    expect(process.env.DERIVED).toBe('/path');
  });

  it('变量展开引用 process.env 已有变量', () => {
    process.env.EXISTING = 'from-shell';
    writeEnv('.env', 'DERIVED="${EXISTING}/v1"\n');
    loadEnv(tempDir);
    expect(process.env.DERIVED).toBe('from-shell/v1');
  });
});
