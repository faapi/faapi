// faapi API 路由:POST 示例
export interface CreateBody {
  name: string;
}

export function POST(body: CreateBody) {
  return { created: true, name: body.name, source: 'faapi' };
}
