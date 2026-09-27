// params/query 类型转换验证 fixture：路径段与 query 来源均为 string，
// schema 按声明类型 coerce——handler 应拿到 number/boolean 而非原始字符串
export interface OrderParams {
  orderId: number;
}

export interface OrderQuery {
  verbose: boolean;
  limit?: number;
}

export function GET(params: OrderParams, query: OrderQuery) {
  const raw = query as Record<string, unknown>;
  return {
    orderId: params.orderId,
    orderIdType: typeof params.orderId,
    verbose: query.verbose,
    verboseType: typeof query.verbose,
    limit: query.limit ?? null,
    // 未在 OrderQuery 中声明的字段不被 schema 剥掉，保留原始字符串
    extra: raw['extra'] ?? null,
  };
}

export interface OrderCreateBody {
  title: string;
}

export function POST(params: OrderParams, body: OrderCreateBody) {
  return {
    orderId: params.orderId,
    orderIdType: typeof params.orderId,
    title: body.title,
  };
}
