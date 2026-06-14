export function POST(ctx: any) {
  ctx.setStatus(201);
  return { created: true };
}
