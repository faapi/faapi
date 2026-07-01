import { describe, it, expect } from 'vitest';
import { resolveAlias } from './resolveAlias';
import type { TsconfigPathsConfig } from './readTsconfig';

const config: TsconfigPathsConfig = {
  baseUrl: '/project',
  paths: {
    '@/*': ['/project/src/*'],
    '@lib': ['/project/src/lib'],
    '~/*': ['/project/src/utils/*', '/project/shared/*'],
  },
};

describe('resolveAlias', () => {
  it('通配匹配：@/lib/db → /project/src/lib/db', () => {
    expect(resolveAlias('@/lib/db', config)).toEqual(['/project/src/lib/db']);
  });

  it('精确匹配：@lib → /project/src/lib', () => {
    expect(resolveAlias('@lib', config)).toEqual(['/project/src/lib']);
  });

  it('精确匹配不匹配部分字符串', () => {
    expect(resolveAlias('@lib/extra', config)).toEqual([]);
  });

  it('多目标通配：~/foo 返回两个候选', () => {
    expect(resolveAlias('~/foo', config)).toEqual([
      '/project/src/utils/foo',
      '/project/shared/foo',
    ]);
  });

  it('通配捕获中间多段路径：@/lib/utils/db', () => {
    expect(resolveAlias('@/lib/utils/db', config)).toEqual([
      '/project/src/lib/utils/db',
    ]);
  });

  it('无匹配返回空数组', () => {
    expect(resolveAlias('react', config)).toEqual([]);
    expect(resolveAlias('./relative', config)).toEqual([]);
  });

  it('通配 pattern 不匹配缺 prefix 的 specifier', () => {
    expect(resolveAlias('@lib', config)).toEqual(['/project/src/lib']); // 精确匹配命中
    expect(resolveAlias('@/lib', config)).toEqual(['/project/src/lib']); // 通配命中
    // @lib 被 @/* 通配匹配吗？prefix=@/，@lib 不以 @/ 开头，不匹配；但 @lib 精确匹配命中
  });

  it('通配 pattern 缺 suffix 也能匹配', () => {
    // pattern @/* 无 suffix，specifier @/ 捕获空字符串
    expect(resolveAlias('@/', config)).toEqual(['/project/src/']);
  });

  it('通配 pattern suffix 非空时要求 specifier 以 suffix 结尾', () => {
    const cfg: TsconfigPathsConfig = {
      baseUrl: '/p',
      paths: { '@lib/*-util': ['/p/utils/*-util'] },
    };
    expect(resolveAlias('@lib/foo-util', cfg)).toEqual(['/p/utils/foo-util']);
    expect(resolveAlias('@lib/foo', cfg)).toEqual([]);
  });

  it('空 paths 配置返回空数组', () => {
    const cfg: TsconfigPathsConfig = { baseUrl: '/p', paths: {} };
    expect(resolveAlias('@/foo', cfg)).toEqual([]);
  });
});
