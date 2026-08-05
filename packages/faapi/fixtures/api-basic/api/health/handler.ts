export function GET() { return { status: 'ok' } }
export function HEAD() { return new Response(null, { status: 204 }) }
