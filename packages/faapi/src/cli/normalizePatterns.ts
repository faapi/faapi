/**
 * 将逗号分隔的 pattern 字符串拆分为数组
 * 'api/auth/*,api/novel/*' -> ['api/auth/*', 'api/novel/*']
 * 'api/auth/*' -> ['api/auth/*']
 */
export function normalizePatterns(patterns: string[]): string[] {
  return patterns
    .flatMap((p) => p.split(','))
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}
