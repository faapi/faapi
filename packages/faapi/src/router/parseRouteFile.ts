import { normalizePath } from '../utils/normalizePath';

/**
 * 将 [name] 格式的目录名转换为 :name 格式
 * '[id]' -> ':id'
 * '[...slug]' -> ':...slug'
 * 'login' -> 'login'
 */
export function dynamicSegmentToParam(segment: string): string {
  const match = segment.match(/^\[(.+)\]$/);
  if (match) {
    return ':' + match[1];
  }
  return segment;
}

/**
 * 从 URL 路径中提取动态参数名
 * '/user/:id' -> ['id']
 * '/auth/login' -> []
 * '/user/:id/posts/:postId' -> ['id', 'postId']
 * '/shop/:...slug' -> ['slug']
 */
export function extractParamNames(urlPath: string): string[] {
  const params: string[] = [];
  const segments = urlPath.split('/');
  for (const segment of segments) {
    if (segment.startsWith(':...')) {
      // catch-all 参数：:...slug -> slug
      params.push(segment.slice(4));
    } else if (segment.startsWith(':')) {
      params.push(segment.slice(1));
    }
  }
  return params;
}

/**
 * 判断路径段是否为 catch-all 路由
 * '[...slug]' -> true
 * '[id]' -> false
 */
export function isCatchAllSegment(segment: string): boolean {
  return /^\[\.\.\..+\]$/.test(segment);
}

/**
 * 判断路径段是否为路由分组
 * '(marketing)' -> true
 * 'login' -> false
 */
export function isRouteGroup(segment: string): boolean {
  return /^\(.+\)$/.test(segment);
}

/**
 * 将路由文件路径转换为 URL 路径
 * 输入: 相对于项目根目录的文件路径，如 'api/auth/login/handler.ts'
 * 输出: URL 路径，如 '/api/auth/login'
 *
 * 规则:
 * - 去掉 appDir 前缀（默认 '.'，即项目根目录，不剥离）
 * - 去掉文件名（handler.ts 等）
 * - 将 [id] 转换为 :id
 * - 忽略路由分组 (groupName) — 不影响 URL
 * - 标准化路径
 *
 * 说明：CLI 默认扫描 src/api/（appDir='src'），底层 API 默认 '.'。
 * 无论 appDir 是 'src' 还是 '.'，api/ 前缀都保留在 URL 中，因此 URL 始终带 /api 前缀。
 */
export function filePathToUrlPath(filePath: string, appDir: string = '.'): string {
  // 去掉 appDir 前缀（appDir='.' 时不剥离）
  const withoutPrefix = filePath.startsWith(appDir + '/')
    ? filePath.slice(appDir.length + 1)
    : filePath;

  // 去掉文件名（最后一个路径段）
  const lastSlashIndex = withoutPrefix.lastIndexOf('/');
  const dirPath = lastSlashIndex === -1 ? '' : withoutPrefix.slice(0, lastSlashIndex);

  if (!dirPath) {
    return '';
  }

  // 将每个路径段中的 [name] 转换为 :name，忽略路由分组 (name)
  const segments = dirPath
    .split('/')
    .filter((s) => !isRouteGroup(s)) // 过滤掉路由分组
    .map(dynamicSegmentToParam);

  // 拼接并标准化路径
  return normalizePath(segments.join('/'));
}
