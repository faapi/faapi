import type { FaapiMiddleware } from './middlewareTypes';

export interface HelmetOptions {
  contentSecurityPolicy?: string | false;
  xFrameOptions?: 'DENY' | 'SAMEORIGIN' | false;
  xContentTypeOptions?: boolean;
  referrerPolicy?: string | false;
  strictTransportSecurity?: string | false;
  xDnsPrefetchControl?: boolean;
  xDownloadOptions?: boolean;
  xPermittedCrossDomainPolicies?: string | false;
  crossOriginOpenerPolicy?: string | false;
  crossOriginResourcePolicy?: string | false;
  crossOriginEmbedderPolicy?: string | false;
  originAgentCluster?: boolean;
  xPoweredBy?: boolean;
}

const DEFAULTS: Required<Omit<HelmetOptions, 'contentSecurityPolicy'>> & {
  contentSecurityPolicy: string | false;
} = {
  contentSecurityPolicy: "default-src 'self'",
  xFrameOptions: 'SAMEORIGIN',
  xContentTypeOptions: true,
  referrerPolicy: 'no-referrer',
  strictTransportSecurity: 'max-age=31536000; includeSubDomains',
  xDnsPrefetchControl: true,
  xDownloadOptions: true,
  xPermittedCrossDomainPolicies: 'none',
  crossOriginOpenerPolicy: 'same-origin',
  crossOriginResourcePolicy: 'same-origin',
  crossOriginEmbedderPolicy: false,
  originAgentCluster: true,
  xPoweredBy: true,
};

export function helmet(options: HelmetOptions = {}): FaapiMiddleware {
  const opts = { ...DEFAULTS, ...options };

  return async (ctx, next) => {
    if (opts.contentSecurityPolicy !== false) {
      ctx.setHeader('Content-Security-Policy', opts.contentSecurityPolicy);
    }
    if (opts.xFrameOptions !== false) {
      ctx.setHeader('X-Frame-Options', opts.xFrameOptions);
    }
    if (opts.xContentTypeOptions) {
      ctx.setHeader('X-Content-Type-Options', 'nosniff');
    }
    if (opts.referrerPolicy !== false) {
      ctx.setHeader('Referrer-Policy', opts.referrerPolicy);
    }
    if (opts.strictTransportSecurity !== false) {
      ctx.setHeader('Strict-Transport-Security', opts.strictTransportSecurity);
    }
    if (opts.xDnsPrefetchControl) {
      ctx.setHeader('X-DNS-Prefetch-Control', 'off');
    }
    if (opts.xDownloadOptions) {
      ctx.setHeader('X-Download-Options', 'noopen');
    }
    if (opts.xPermittedCrossDomainPolicies !== false) {
      ctx.setHeader('X-Permitted-Cross-Domain-Policies', opts.xPermittedCrossDomainPolicies);
    }
    if (opts.crossOriginOpenerPolicy !== false) {
      ctx.setHeader('Cross-Origin-Opener-Policy', opts.crossOriginOpenerPolicy);
    }
    if (opts.crossOriginResourcePolicy !== false) {
      ctx.setHeader('Cross-Origin-Resource-Policy', opts.crossOriginResourcePolicy);
    }
    if (opts.crossOriginEmbedderPolicy !== false) {
      ctx.setHeader('Cross-Origin-Embedder-Policy', opts.crossOriginEmbedderPolicy);
    }
    if (opts.originAgentCluster) {
      ctx.setHeader('Origin-Agent-Cluster', '?1');
    }
    if (opts.xPoweredBy) {
      ctx.setHeader('X-Powered-By', 'faapi');
    }

    return await next();
  };
}
