export function GET(ctx: any) {
  ctx.setCookie('token', 'abc123', { httpOnly: true });
  return { ok: true };
}
