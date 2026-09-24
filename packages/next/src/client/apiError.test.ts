import { describe, it, expect } from 'vitest';
import { ApiError, type ApiValidationIssue } from './apiError';

describe('ApiError', () => {
  it('是 Error 实例,name 为 ApiError', () => {
    const err = new ApiError('INTERNAL_ERROR', 500, '服务器内部错误');
    expect(err instanceof Error).toBe(true);
    expect(err.name).toBe('ApiError');
  });

  it('code/status/message 正确赋值', () => {
    const err = new ApiError('USER_NOT_FOUND', 404, '用户不存在');
    expect(err.code).toBe('USER_NOT_FOUND');
    expect(err.status).toBe(404);
    expect(err.message).toBe('用户不存在');
  });

  it('message 会被现有 e instanceof Error 消费代码读取', () => {
    const err = new ApiError('HTTP_ERROR', 500, '请求失败');
    // toast 固定姿势:e instanceof Error ? e.message : String(e)
    expect(err instanceof Error ? err.message : String(err)).toBe('请求失败');
  });

  it('可选 issues 挂载:VALIDATION_ERROR 字段级详情', () => {
    const issues: ApiValidationIssue[] = [
      {
        path: 'page',
        code: 'TYPE_MISMATCH',
        expected: 'number',
        received: 'string',
        message: 'page expected number, got string',
      },
    ];
    const err = new ApiError('VALIDATION_ERROR', 422, '参数校验失败', issues);
    expect(err.issues).toEqual(issues);
  });

  it('issues 省略时为 undefined', () => {
    const err = new ApiError('HTTP_ERROR', 500, '请求失败');
    expect(err.issues).toBeUndefined();
  });
});
