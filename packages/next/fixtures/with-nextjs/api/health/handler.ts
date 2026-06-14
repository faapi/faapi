// faapi API 路由:返回健康状态
export function GET() {
  return { status: 'ok', source: 'faapi' };
}
