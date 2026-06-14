import { describe, it, expect } from 'vitest';
import {
  ValidationError,
  RouteNotFoundError,
  MethodNotAllowedError,
  InternalError,
  ModuleLoadError,
} from './httpErrors';
import { FaapiError } from './FaapiError';

describe('ValidationError', () => {
  it('MISSING_FIELD issue → statusCode 400', () => {
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
    expect(error).toBeInstanceOf(FaapiError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ValidationError');
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.statusCode).toBe(400);
    expect(error.message).toBe('Invalid input');
    expect(error.issues).toEqual(issues);
  });

  it('INVALID_FORMAT issue → statusCode 400', () => {
    const issues = [
      {
        path: 'body',
        code: 'INVALID_FORMAT' as const,
        expected: 'JSON',
        received: 'text',
        message: 'invalid json',
      },
    ];
    const error = new ValidationError('Invalid JSON', issues);
    expect(error.statusCode).toBe(400);
  });

  it('TYPE_MISMATCH issue → statusCode 422', () => {
    const issues = [
      {
        path: 'age',
        code: 'TYPE_MISMATCH' as const,
        expected: 'number',
        received: 'string',
        message: 'type error',
      },
    ];
    const error = new ValidationError('Type mismatch', issues);
    expect(error.statusCode).toBe(422);
  });

  it('INVALID_VALUE issue → statusCode 422', () => {
    const issues = [
      {
        path: 'role',
        code: 'INVALID_VALUE' as const,
        expected: "'admin'",
        received: "'guest'",
        message: 'value not allowed',
      },
    ];
    const error = new ValidationError('Invalid value', issues);
    expect(error.statusCode).toBe(422);
  });

  it('COERCE_FAILED issue → statusCode 422', () => {
    const issues = [
      {
        path: 'page',
        code: 'COERCE_FAILED' as const,
        expected: 'number',
        received: 'string',
        message: 'coerce failed',
      },
    ];
    const error = new ValidationError('Coerce failed', issues);
    expect(error.statusCode).toBe(422);
  });

  it('多个 issue 时 400 类优先于 422 类', () => {
    // 同时有 TYPE_MISMATCH(422) 和 MISSING_FIELD(400),应取 400
    const issues = [
      {
        path: 'age',
        code: 'TYPE_MISMATCH' as const,
        expected: 'number',
        received: 'string',
        message: 'type error',
      },
      {
        path: 'name',
        code: 'MISSING_FIELD' as const,
        expected: 'name',
        received: 'undefined',
        message: 'required',
      },
    ];
    const error = new ValidationError('Multiple errors', issues);
    expect(error.statusCode).toBe(400);
  });

  it('仅有 422 类 issue 时为 422', () => {
    const issues = [
      {
        path: 'age',
        code: 'TYPE_MISMATCH' as const,
        expected: 'number',
        received: 'string',
        message: 'type error',
      },
      {
        path: 'role',
        code: 'INVALID_VALUE' as const,
        expected: "'admin'",
        received: "'guest'",
        message: 'value not allowed',
      },
    ];
    const error = new ValidationError('All 422', issues);
    expect(error.statusCode).toBe(422);
  });
});

describe('RouteNotFoundError', () => {
  it('构造正确，statusCode 为 404', () => {
    const error = new RouteNotFoundError('/api/users');
    expect(error).toBeInstanceOf(FaapiError);
    expect(error.name).toBe('RouteNotFoundError');
    expect(error.code).toBe('ROUTE_NOT_FOUND');
    expect(error.statusCode).toBe(404);
    expect(error.message).toBe('Route not found: /api/users');
  });
});

describe('MethodNotAllowedError', () => {
  it('构造正确，statusCode 为 405，allowedMethods 正确', () => {
    const error = new MethodNotAllowedError('POST', '/api/users', ['GET', 'PUT']);
    expect(error).toBeInstanceOf(FaapiError);
    expect(error.name).toBe('MethodNotAllowedError');
    expect(error.code).toBe('METHOD_NOT_ALLOWED');
    expect(error.statusCode).toBe(405);
    expect(error.message).toBe('Method POST not allowed for /api/users');
    expect(error.allowedMethods).toEqual(['GET', 'PUT']);
  });
});

describe('InternalError', () => {
  it('构造正确，statusCode 为 500', () => {
    const error = new InternalError('Something went wrong');
    expect(error).toBeInstanceOf(FaapiError);
    expect(error.name).toBe('InternalError');
    expect(error.code).toBe('INTERNAL_ERROR');
    expect(error.statusCode).toBe(500);
    expect(error.message).toBe('Something went wrong');
  });
});

describe('ModuleLoadError', () => {
  it('构造正确，statusCode 为 500', () => {
    const error = new ModuleLoadError('./routes/users.ts', 'syntax error');
    expect(error).toBeInstanceOf(FaapiError);
    expect(error.name).toBe('ModuleLoadError');
    expect(error.code).toBe('MODULE_LOAD_ERROR');
    expect(error.statusCode).toBe(500);
    expect(error.message).toBe('Failed to load module ./routes/users.ts: syntax error');
  });
});
