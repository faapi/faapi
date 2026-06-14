import type { FaapiMiddleware } from './middlewareTypes';

export interface CorsOptions {
  origin?: string | string[] | true;
  methods?: string[];
  allowedHeaders?: string[];
  exposeHeaders?: string[];
  credentials?: boolean;
  maxAge?: number;
}

const DEFAULT_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

/**
 * 创建 CORS 中间件（洋葱模型）
 *
 * - origin=true: 允许所有来源（反射请求的 Origin）
 * - origin=string: 允许指定来源
 * - origin=string[]: 允许多个来源
 *
 * OPTIONS 预检请求直接返回 204，不调用 next()。
 */
export function cors(options: CorsOptions = {}): FaapiMiddleware {
  const {
    origin = true,
    methods = DEFAULT_METHODS,
    allowedHeaders,
    exposeHeaders,
    credentials = false,
    maxAge,
  } = options;

  return async (ctx, next) => {
    const reqOrigin = ctx.headers.get('origin');
    if (!reqOrigin) {
      await next();
      return;
    }

    // 确定允许的来源
    let allowOrigin: string | null = null;
    if (origin === true) {
      allowOrigin = reqOrigin; // 反射 Origin
    } else if (typeof origin === 'string') {
      allowOrigin = reqOrigin === origin ? origin : null;
    } else if (Array.isArray(origin)) {
      allowOrigin = origin.includes(reqOrigin) ? reqOrigin : null;
    }

    if (!allowOrigin) {
      await next();
      return;
    }

    // 设置 CORS 响应头
    ctx.setHeader('Access-Control-Allow-Origin', allowOrigin);

    // 当 origin 为动态值（true 或数组）时，必须设置 Vary: Origin，
    // 防止 CDN/浏览器错误缓存针对某个 Origin 的响应给其他 Origin
    if (origin === true || Array.isArray(origin)) {
      const existingVary = ctx.headers.get('vary');
      if (existingVary) {
        if (!existingVary.toLowerCase().includes('origin')) {
          ctx.setHeader('Vary', `${existingVary}, Origin`);
        }
      } else {
        ctx.setHeader('Vary', 'Origin');
      }
    }

    ctx.setHeader('Access-Control-Allow-Methods', methods.join(', '));

    if (allowedHeaders) {
      ctx.setHeader('Access-Control-Allow-Headers', allowedHeaders.join(', '));
    } else {
      // 反射请求头
      const requestHeaders = ctx.headers.get('access-control-request-headers');
      if (requestHeaders) {
        ctx.setHeader('Access-Control-Allow-Headers', requestHeaders);
      }
    }

    if (exposeHeaders && exposeHeaders.length > 0) {
      ctx.setHeader('Access-Control-Expose-Headers', exposeHeaders.join(', '));
    }

    if (credentials) {
      ctx.setHeader('Access-Control-Allow-Credentials', 'true');
    }

    if (maxAge !== undefined) {
      ctx.setHeader('Access-Control-Max-Age', String(maxAge));
    }

    // 处理 preflight 请求：直接返回 204，不调用 next()
    if (ctx.method === 'OPTIONS') {
      return new Response(null, { status: 204 });
    }

    await next();
  };
}
