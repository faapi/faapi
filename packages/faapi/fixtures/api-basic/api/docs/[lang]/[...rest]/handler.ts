// catch-all + params 声明 fixture：rest 段不在 DocParams 声明内，
// 验证回写以原始 params 打底合并——z.object 不把声明之外的段剥掉
export interface DocParams {
  lang: string;
}

export function GET(params: DocParams) {
  const raw = params as Record<string, unknown>;
  return {
    lang: params.lang,
    langType: typeof params.lang,
    rest: raw['rest'] ?? null,
    restType: typeof raw['rest'],
  };
}
