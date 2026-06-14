// faapi API 路由:带参数的动态路由
export interface Params {
  id: string;
}

export function GET(params: Params) {
  return { id: params.id, source: 'faapi' };
}
