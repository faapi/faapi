/**
 * 测试：query 和 body 参数注入
 */

export interface Query {
  page: number;
  pageSize: number;
}

export interface CreateUserBody {
  name: string;
  email: string;
}

// 变量名 query → 自动注入查询参数
export function GET(query: Query) {
  return {
    injected: 'query',
    page: query.page,
    pageSize: query.pageSize,
  };
}

// 变量名 body → 自动注入请求体
export function POST(body: CreateUserBody) {
  return {
    injected: 'body',
    name: body.name,
    email: body.email,
  };
}
