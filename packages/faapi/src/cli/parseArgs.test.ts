import { describe, it, expect } from 'vitest';
import { parseArgs } from './parseArgs';

describe('parseArgs', () => {
  it('解析单个 pattern', () => {
    const result = parseArgs(['api/auth/*']);
    expect(result.patterns).toEqual(['api/auth/*']);
  });

  it('解析多个 pattern', () => {
    const result = parseArgs(['api/auth/*', 'api/novel/*']);
    expect(result.patterns).toEqual(['api/auth/*', 'api/novel/*']);
  });

  it('解析逗号分隔的 pattern', () => {
    const result = parseArgs(['api/auth/*,api/novel/*']);
    expect(result.patterns).toEqual(['api/auth/*', 'api/novel/*']);
  });

  it('解析 --port 参数', () => {
    const result = parseArgs(['--port', '4000', 'api/auth/*']);
    expect(result.port).toBe(4000);
  });

  it('默认端口为 3000', () => {
    const result = parseArgs(['api/auth/*']);
    expect(result.port).toBe(3000);
  });

  it('解析 --app-dir 参数', () => {
    const result = parseArgs(['--app-dir', 'src', 'api/auth/*']);
    expect(result.appDir).toBe('src');
  });

  it('默认 appDir 为 src', () => {
    const result = parseArgs(['src/api/auth/*']);
    expect(result.appDir).toBe('src');
  });

  it('无参数时 patterns 默认为 src/api/**/*.ts', () => {
    const result = parseArgs([]);
    expect(result.patterns).toEqual(['src/api/**/*.ts']);
  });

  it('--app-dir . 时回退为 api/**/*.ts（向后兼容）', () => {
    const result = parseArgs(['--app-dir', '.']);
    expect(result.appDir).toBe('.');
    expect(result.patterns).toEqual(['api/**/*.ts']);
  });

  it('无命令词时 mode 默认为 dev', () => {
    const result = parseArgs([]);
    expect(result.mode).toBe('dev');
  });

  it('faapi dev → mode 为 dev', () => {
    const result = parseArgs(['dev']);
    expect(result.mode).toBe('dev');
    // dev 命令词不进入 patterns
    expect(result.patterns).toEqual(['src/api/**/*.ts']);
  });

  it('faapi start → mode 为 start', () => {
    const result = parseArgs(['start']);
    expect(result.mode).toBe('start');
    expect(result.patterns).toEqual(['src/api/**/*.ts']);
  });

  it('faapi start api/auth/* → mode 为 start，patterns 保留', () => {
    const result = parseArgs(['start', 'api/auth/*']);
    expect(result.mode).toBe('start');
    expect(result.patterns).toEqual(['api/auth/*']);
  });

  it('faapi dev --port 4000 → mode 为 dev，参数正常解析', () => {
    const result = parseArgs(['dev', '--port', '4000']);
    expect(result.mode).toBe('dev');
    expect(result.port).toBe(4000);
  });
});
