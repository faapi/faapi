import { describe, it, expect } from 'vitest';
import { getSchemaName } from './schemaName';

describe('getSchemaName', () => {
  it('GET + query -> GETQuery', () => {
    expect(getSchemaName('GET', 'query')).toBe('GETQuery');
  });

  it('POST + body -> POSTBody', () => {
    expect(getSchemaName('POST', 'body')).toBe('POSTBody');
  });

  it('GET + params -> GETParams', () => {
    expect(getSchemaName('GET', 'params')).toBe('GETParams');
  });

  it('小写 method 自动转大写', () => {
    expect(getSchemaName('get', 'query')).toBe('GETQuery');
    expect(getSchemaName('post', 'body')).toBe('POSTBody');
  });

  it('DELETE + params -> DELETEParams', () => {
    expect(getSchemaName('DELETE', 'params')).toBe('DELETEParams');
  });
});
