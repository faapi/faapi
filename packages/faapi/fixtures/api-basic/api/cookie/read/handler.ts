export function GET(ctx: any) {
  return { cookies: ctx.cookies, sessionId: ctx.getCookie('sessionId') };
}
