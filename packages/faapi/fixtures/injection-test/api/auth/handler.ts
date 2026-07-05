/**
 * 测试：多参数注入（顺序不固定）+ context 注入
 */

import type { FaapiContext } from '@faapi/faapi';

export interface Query {
  fields?: string;
}

export function GET(headers: Headers, query: Query) {
  return {
    injected: 'headers+query',
    hasAuth: !!headers.get('authorization'),
    fields: query.fields,
  };
}

// context 注入
export function POST(context: FaapiContext) {
  return {
    injected: 'context',
    method: context.method,
    path: context.path,
  };
}
