import { describe, it, expect } from 'vitest';
import { formatErrorResponse } from './formatErrorResponse';
import {
  ValidationError,
  RouteNotFoundError,
  MethodNotAllowedError,
  InternalError,
  ModuleLoadError,
} from './httpErrors';
import { FaapiError } from './FaapiError';

describe('formatErrorResponse', () => {
  it('ValidationError 格式化包含 issues 数组', async () => {
    const issues = [
      {
        path: 'name',
        code: 'MISSING_FIELD' as const,
        expected: 'name',
        received: 'undefined',
        message: 'required',
      },
    ];
    const error = new ValidationError('Invalid input', issues);
    const response = formatErrorResponse(error);

    expect(response.status).toBe(400);
    expect(response.headers.get('Content-Type')).toBe('application/json');

    const body = await response.json();
    expect(body).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid input',
        issues,
      },
    });
  });

  it('RouteNotFoundError 格式化包含 code 和 message', async () => {
    const error = new RouteNotFoundError('/api/users');
    const response = formatErrorResponse(error);

    expect(response.status).toBe(404);
    expect(response.headers.get('Content-Type')).toBe('application/json');

    const body = await response.json();
    expect(body).toEqual({
      error: {
        code: 'ROUTE_NOT_FOUND',
        message: 'Route not found: /api/users',
      },
    });
  });

  it('MethodNotAllowedError 格式化包含 Allow header', async () => {
    const error = new MethodNotAllowedError('POST', '/api/users', ['GET', 'PUT']);
    const response = formatErrorResponse(error);

    expect(response.status).toBe(405);
    expect(response.headers.get('Content-Type')).toBe('application/json');
    expect(response.headers.get('Allow')).toBe('GET, PUT');

    const body = await response.json();
    expect(body).toEqual({
      error: {
        code: 'METHOD_NOT_ALLOWED',
        message: 'Method POST not allowed for /api/users',
      },
    });
  });

  it('未知 Error 格式化为 500 INTERNAL_ERROR', async () => {
    const error = new Error('something broke');
    const response = formatErrorResponse(error);

    expect(response.status).toBe(500);
    expect(response.headers.get('Content-Type')).toBe('application/json');

    const body = await response.json();
    expect(body).toEqual({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'something broke',
      },
    });
  });

  it('非 Error 值格式化为 500 INTERNAL_ERROR', async () => {
    const response = formatErrorResponse('string error');

    expect(response.status).toBe(500);
    expect(response.headers.get('Content-Type')).toBe('application/json');

    const body = await response.json();
    expect(body).toEqual({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unknown error occurred',
      },
    });
  });

  it('InternalError 返回 500 和 INTERNAL_ERROR code', async () => {
    const error = new InternalError('database connection failed');
    const response = formatErrorResponse(error);

    expect(response.status).toBe(500);
    expect(response.headers.get('Content-Type')).toBe('application/json');

    const body = await response.json();
    expect(body).toEqual({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'database connection failed',
      },
    });
  });

  it('ModuleLoadError 返回 500 和 MODULE_LOAD_ERROR code', async () => {
    const error = new ModuleLoadError('api/auth/handler.ts', 'syntax error');
    const response = formatErrorResponse(error);

    expect(response.status).toBe(500);
    expect(response.headers.get('Content-Type')).toBe('application/json');

    const body = await response.json();
    expect(body).toEqual({
      error: {
        code: 'MODULE_LOAD_ERROR',
        message: 'Failed to load module api/auth/handler.ts: syntax error',
      },
    });
  });

  it('非 Error 对象格式化为 500 INTERNAL_ERROR', async () => {
    const response = formatErrorResponse({ foo: 'bar' });

    expect(response.status).toBe(500);
    expect(response.headers.get('Content-Type')).toBe('application/json');

    const body = await response.json();
    expect(body).toEqual({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unknown error occurred',
      },
    });
  });

  it('FaapiError 子类（非特定类型）走 FaapiError 通用分支', async () => {
    // 测试用 CUSTOM_CODE 不在 ErrorCode 联合类型中，cast 以便测试 FaapiError 通用分支
    const error = new FaapiError('CUSTOM_CODE' as any, 'custom error', 422);
    const response = formatErrorResponse(error);

    expect(response.status).toBe(422);
    expect(response.headers.get('Content-Type')).toBe('application/json');

    const body = await response.json();
    expect(body).toEqual({
      error: {
        code: 'CUSTOM_CODE',
        message: 'custom error',
      },
    });
  });
});
