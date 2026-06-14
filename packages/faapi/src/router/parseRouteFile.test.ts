import { describe, it, expect } from 'vitest';
import {
  filePathToUrlPath,
  extractParamNames,
  dynamicSegmentToParam,
  isRouteGroup,
  isCatchAllSegment,
} from './parseRouteFile';

describe('filePathToUrlPath', () => {
  it.each([
    // API 路由：api/ 下，URL 带 /api 前缀
    ['api/auth/login/handler.ts', '/api/auth/login'],
    ['api/user/[id]/handler.ts', '/api/user/:id'],
    ['api/novel/list/handler.ts', '/api/novel/list'],
    ['api/user/[id]/posts/[postId]/handler.ts', '/api/user/:id/posts/:postId'],
    ['api/handler.ts', '/api'],
    // 路由分组：(groupName) 不影响 URL
    ['api/(marketing)/about/handler.ts', '/api/about'],
    ['api/(shop)/products/handler.ts', '/api/products'],
    ['api/(admin)/dashboard/handler.ts', '/api/dashboard'],
    // catch-all 路由：[...slug] -> :...slug
    ['api/shop/[...slug]/handler.ts', '/api/shop/:...slug'],
  ] as const)('filePathToUrlPath(%s) -> %s', (input, expected) => {
    expect(filePathToUrlPath(input)).toBe(expected);
  });
});

describe('extractParamNames', () => {
  it.each([
    ['/user/:id', ['id']],
    ['/auth/login', []],
    ['/user/:id/posts/:postId', ['id', 'postId']],
    // catch-all 参数：:...slug -> ['slug']
    ['/shop/:...slug', ['slug']],
    ['/docs/:...slug', ['slug']],
  ] as const)('extractParamNames(%s) -> %j', (input, expected) => {
    expect(extractParamNames(input)).toEqual(expected);
  });
});

describe('dynamicSegmentToParam', () => {
  it.each([
    ['[id]', ':id'],
    ['login', 'login'],
    // catch-all 段
    ['[...slug]', ':...slug'],
  ] as const)('dynamicSegmentToParam(%s) -> %s', (input, expected) => {
    expect(dynamicSegmentToParam(input)).toBe(expected);
  });
});

describe('isRouteGroup', () => {
  it.each([
    ['(marketing)', true],
    ['(shop)', true],
    ['(admin)', true],
    ['login', false],
    ['[id]', false],
    ['()', false],
  ] as const)('isRouteGroup(%s) -> %s', (input, expected) => {
    expect(isRouteGroup(input)).toBe(expected);
  });
});

describe('isCatchAllSegment', () => {
  it.each([
    ['[...slug]', true],
    ['[...path]', true],
    ['[id]', false],
    ['login', false],
    ['(marketing)', false],
  ] as const)('isCatchAllSegment(%s) -> %s', (input, expected) => {
    expect(isCatchAllSegment(input)).toBe(expected);
  });
});
