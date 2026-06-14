/**
 * 测试：多参数注入（顺序不固定）+ context 注入
 */

import type { FaapiContext } from '@faapi/faapi';

// headers 注入的是 Web 标准 Headers 对象
export interface Headers {
  authorization?: string;
}

export interface Query {
  fields?: string;
}

// headers 在前，query 在后
export function GET(headers: globalThis.Headers, query: Query) {
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
