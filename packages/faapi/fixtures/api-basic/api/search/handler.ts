// body 方法次输入验证 fixture：POST 主输入是 body，声明 query 形参
// 同样应按类型校验转换（POSTQuery schema）——此前注入恒为原始字符串
export interface SearchQuery {
  page: number;
}

export interface SearchBody {
  keyword: string;
}

export function POST(query: SearchQuery, body: SearchBody) {
  const raw = query as Record<string, unknown>;
  return {
    page: query.page,
    pageType: typeof query.page,
    keyword: body.keyword,
    // 未在 SearchQuery 中声明的字段保留原始字符串（原始值打底合并）
    extra: raw['extra'] ?? null,
  };
}
