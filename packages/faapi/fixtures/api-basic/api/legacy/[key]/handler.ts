// params 声明为 string：路径段保持字符串——转换由声明类型驱动
export interface LegacyParams {
  key: string;
}

export function GET(params: LegacyParams) {
  return { key: params.key, keyType: typeof params.key };
}
