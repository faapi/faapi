import type { TsconfigPathsConfig } from './readTsconfig';

/**
 * 按 tsconfig paths 配置把 import specifier 解析为候选绝对路径
 *
 * 纯函数，不检查文件存在性。调用方需自行尝试 .ts/.js/index 等后缀。
 * 支持精确匹配（无 *）和单个 * 通配匹配。
 */
export function resolveAlias(specifier: string, config: TsconfigPathsConfig): string[] {
  const candidates: string[] = [];

  for (const [pattern, targets] of Object.entries(config.paths)) {
    const wildcardIndex = pattern.indexOf('*');

    if (wildcardIndex === -1) {
      // 精确匹配
      if (specifier === pattern) {
        candidates.push(...targets);
      }
      continue;
    }

    // 通配匹配：按 * 分割为 prefix / suffix
    const prefix = pattern.slice(0, wildcardIndex);
    const suffix = pattern.slice(wildcardIndex + 1);

    if (
      specifier.startsWith(prefix) &&
      specifier.endsWith(suffix) &&
      specifier.length >= prefix.length + suffix.length
    ) {
      const captured = specifier.slice(prefix.length, specifier.length - suffix.length);
      for (const target of targets) {
        candidates.push(target.replace('*', captured));
      }
    }
  }

  return candidates;
}
