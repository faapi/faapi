export function GET(ctx: any) {
  ctx.deleteCookie('token');
  return { ok: true };
}
