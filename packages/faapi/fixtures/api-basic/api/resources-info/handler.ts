export function GET(ctx: { resourcesDir?: string }) {
  return { resourcesDir: ctx.resourcesDir ?? null };
}
