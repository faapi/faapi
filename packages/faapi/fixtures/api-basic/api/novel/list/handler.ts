export function GET(ctx: any) {
  ctx.setHeader('Cache-Control', 'max-age=3600');
  return { cached: true };
}
