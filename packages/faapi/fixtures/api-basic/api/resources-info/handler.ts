export function GET(ctx: Record<string, unknown>) {
  return { hasResourcesDir: 'resourcesDir' in ctx };
}
