import { describe, it, expect } from 'vitest';
import {
  APP_DIR,
  ROUTE_PATTERNS,
  toProdFilePath,
  toProdExtension,
  toRealPath,
  isInsideDir,
  stripSrcPrefix,
} from './prodPaths';

describe('toProdFilePath', () => {
  it('strip src/ 前缀 + 补 dist 前缀 + .ts → .js', () => {
    expect(toProdFilePath('src/api/hello/handler.ts', 'dist')).toBe('dist/api/hello/handler.js');
  });

  it('dev 产物目录（.faapi）同样适用', () => {
    expect(toProdFilePath('src/api/user/handler.ts', '.faapi')).toBe('.faapi/api/user/handler.js');
  });

  it('已带 dist 前缀的输入保持不变（幂等）', () => {
    expect(toProdFilePath('dist/api/hello/handler.ts', 'dist')).toBe('dist/api/hello/handler.js');
  });

  it('Windows 反斜杠归一化为 /', () => {
    expect(toProdFilePath('src\\api\\hello\\handler.ts', 'dist')).toBe('dist/api/hello/handler.js');
  });

  it('无 src/ 前缀的相对路径原样补 dist（.ts → .js）', () => {
    expect(toProdFilePath('base.ts', 'dist')).toBe('dist/base.js');
  });
});

describe('toProdExtension', () => {
  it('.ts → .js', () => {
    expect(toProdExtension('./a/b.ts')).toBe('./a/b.js');
  });

  it('.tsx / .jsx → .js', () => {
    expect(toProdExtension('./a.tsx')).toBe('./a.js');
    expect(toProdExtension('./a.jsx')).toBe('./a.js');
  });

  it('.js/.mjs/.cjs 及其他保持原样', () => {
    expect(toProdExtension('./a.js')).toBe('./a.js');
    expect(toProdExtension('./a.mjs')).toBe('./a.mjs');
    expect(toProdExtension('./a.cjs')).toBe('./a.cjs');
    expect(toProdExtension('./a.css')).toBe('./a.css');
  });
});

describe('toRealPath', () => {
  it('存在路径返回 realpath', () => {
    expect(toRealPath('/')).toBe('/');
  });

  it('不存在路径回退原路径（不抛错）', () => {
    expect(toRealPath('/nonexistent-faapi-test/a.ts')).toBe('/nonexistent-faapi-test/a.ts');
  });
});

describe('isInsideDir', () => {
  it('子文件在目录内', () => {
    expect(isInsideDir('/proj/src/a.ts', '/proj/src')).toBe(true);
  });

  it('目录本身返回 false（rel 为空）', () => {
    expect(isInsideDir('/proj/src', '/proj/src')).toBe(false);
  });

  it('目录外（.. 前缀）返回 false', () => {
    expect(isInsideDir('/proj/other/a.ts', '/proj/src')).toBe(false);
  });

  it('前缀字符串相同但非子目录返回 false（/proj/src-x vs /proj/src）', () => {
    expect(isInsideDir('/proj/src-x/a.ts', '/proj/src')).toBe(false);
  });

  it('绝对路径输入返回 false', () => {
    expect(isInsideDir('/etc/passwd', '/proj/src')).toBe(false);
  });
});

describe('stripSrcPrefix', () => {
  it('strip src/ 前缀', () => {
    expect(stripSrcPrefix('src/api/hello/handler.ts')).toBe('api/hello/handler.ts');
  });

  it('无前缀原样返回', () => {
    expect(stripSrcPrefix('api/hello/handler.ts')).toBe('api/hello/handler.ts');
  });

  it('反斜杠归一化', () => {
    expect(stripSrcPrefix('src\\api\\handler.ts')).toBe('api/handler.ts');
  });
});

describe('常量', () => {
  it('APP_DIR 固定为 src', () => {
    expect(APP_DIR).toBe('src');
  });

  it('ROUTE_PATTERNS 为 src/api 下的 .ts 扫描', () => {
    expect(ROUTE_PATTERNS).toEqual(['src/api/**/*.ts']);
  });
});
