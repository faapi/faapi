import { describe, it, expect, afterEach } from 'vitest';
import { isSchemaEnabled } from './schemaServer';

describe('isSchemaEnabled', () => {
  const originalSchema = process.env.FAAPI_SCHEMA;
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (originalSchema === undefined) {
      delete process.env.FAAPI_SCHEMA;
    } else {
      process.env.FAAPI_SCHEMA = originalSchema;
    }
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it('FAAPI_SCHEMA=1 强制开启', () => {
    process.env.FAAPI_SCHEMA = '1';
    process.env.NODE_ENV = 'production';
    expect(isSchemaEnabled()).toBe(true);
  });

  it('FAAPI_SCHEMA=true 强制开启', () => {
    process.env.FAAPI_SCHEMA = 'true';
    process.env.NODE_ENV = 'production';
    expect(isSchemaEnabled()).toBe(true);
  });

  it('FAAPI_SCHEMA=0 强制关闭', () => {
    process.env.FAAPI_SCHEMA = '0';
    delete process.env.NODE_ENV;
    expect(isSchemaEnabled()).toBe(false);
  });

  it('FAAPI_SCHEMA=false 强制关闭', () => {
    process.env.FAAPI_SCHEMA = 'false';
    delete process.env.NODE_ENV;
    expect(isSchemaEnabled()).toBe(false);
  });

  it('未设置 FAAPI_SCHEMA 且非 production 环境默认开启', () => {
    delete process.env.FAAPI_SCHEMA;
    delete process.env.NODE_ENV;
    expect(isSchemaEnabled()).toBe(true);
  });

  it('未设置 FAAPI_SCHEMA 且 NODE_ENV=development 默认开启', () => {
    delete process.env.FAAPI_SCHEMA;
    process.env.NODE_ENV = 'development';
    expect(isSchemaEnabled()).toBe(true);
  });

  it('未设置 FAAPI_SCHEMA 且 NODE_ENV=production 默认关闭', () => {
    delete process.env.FAAPI_SCHEMA;
    process.env.NODE_ENV = 'production';
    expect(isSchemaEnabled()).toBe(false);
  });
});
