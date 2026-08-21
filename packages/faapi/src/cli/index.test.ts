import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * CLI 入口（index.ts）命令分发测试
 *
 * index.ts 导出 `createCli()` 函数，返回配置好的 cac 实例。
 * 测试通过 `cli.parse(argv)` 显式传参触发命令分发，避免 cac 的 `process.argv`
 * 快照机制（cac 在模块加载时捕获 processArgs，无参 parse() 用快照）。
 *
 * 通过 vi.mock 替换 devCommand/buildCommand 为 spy，验证分发逻辑正确。
 * 不测试 devCommand/buildCommand 本身（它们已有独立测试），只验证：
 * - `faapi` / `faapi dev` → devCommand
 * - `faapi build` → buildCommand
 * - `faapi --port 4000` → devCommand 收到 port 选项（cac 保留字符串）
 * - `faapi build --dist custom` → buildCommand 收到 dist 选项
 * - `faapi --help` / `faapi -h` → 输出帮助文本，不执行命令
 */
vi.mock('./devCommand.js', () => ({
  devCommand: vi.fn(async () => {}),
}));
vi.mock('./buildCommand.js', () => ({
  buildCommand: vi.fn(async () => {}),
}));

const { devCommand } = await import('./devCommand.js');
const { buildCommand } = await import('./buildCommand.js');
const { createCli } = await import('./index');

let logSpy: ReturnType<typeof vi.spyOn>;

describe('CLI 入口 index.ts 命令分发', () => {
  beforeEach(() => {
    vi.mocked(devCommand).mockClear();
    vi.mocked(buildCommand).mockClear();
    process.env.NODE_ENV = 'test';
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    process.exitCode = 0;
  });

  /** 用显式 argv 调用 createCli().parse()，避免 process.argv 快照问题 */
  async function runCli(argv: string[]): Promise<{ logCalls: unknown[][] }> {
    const cli = createCli();
    cli.parse(argv);
    // 等待 async action 完成（action 内 await import mock 模块 + 调用 spy）
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    return { logCalls: logSpy.mock.calls };
  }

  describe('dev 命令分发', () => {
    it('`faapi`（无子命令）→ devCommand', async () => {
      await runCli(['node', 'faapi']);
      expect(devCommand).toHaveBeenCalledTimes(1);
      expect(buildCommand).not.toHaveBeenCalled();
    });

    it('`faapi dev` → devCommand', async () => {
      await runCli(['node', 'faapi', 'dev']);
      expect(devCommand).toHaveBeenCalledTimes(1);
      expect(buildCommand).not.toHaveBeenCalled();
    });

    it('`faapi --port 4000` → devCommand 收到 port 选项（cac 按 <number> 占位符转数字）', async () => {
      await runCli(['node', 'faapi', '--port', '4000']);
      expect(devCommand).toHaveBeenCalledTimes(1);
      const options = vi.mocked(devCommand).mock.calls[0]?.[0];
      expect(options?.port).toBe(4000);
    });
  });

  describe('build 命令分发', () => {
    it('`faapi build` → buildCommand', async () => {
      await runCli(['node', 'faapi', 'build']);
      expect(buildCommand).toHaveBeenCalledTimes(1);
      expect(devCommand).not.toHaveBeenCalled();
    });

    it('`faapi build --dist custom` → buildCommand 收到 dist 选项', async () => {
      await runCli(['node', 'faapi', 'build', '--dist', 'custom']);
      expect(buildCommand).toHaveBeenCalledTimes(1);
      const options = vi.mocked(buildCommand).mock.calls[0]?.[0];
      expect(options?.dist).toBe('custom');
    });
  });

  describe('help 输出', () => {
    it('`faapi --help` 输出帮助文本，不执行任何命令', async () => {
      const { logCalls } = await runCli(['node', 'faapi', '--help']);
      expect(devCommand).not.toHaveBeenCalled();
      expect(buildCommand).not.toHaveBeenCalled();
      const helpText = logCalls.map((c) => c.join(' ')).join('\n');
      expect(helpText.toLowerCase()).toContain('faapi');
    });

    it('`faapi -h` 等价于 --help', async () => {
      await runCli(['node', 'faapi', '-h']);
      expect(devCommand).not.toHaveBeenCalled();
      expect(buildCommand).not.toHaveBeenCalled();
    });

    it('`faapi build --help` 输出 build 子命令帮助', async () => {
      const { logCalls } = await runCli(['node', 'faapi', 'build', '--help']);
      expect(devCommand).not.toHaveBeenCalled();
      expect(buildCommand).not.toHaveBeenCalled();
      const helpText = logCalls.map((c) => c.join(' ')).join('\n');
      expect(helpText).toContain('--dist');
    });
  });
});
