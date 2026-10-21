import { describe, it, expect } from 'vitest';
import { helmet } from './helmet';
import { invokeHandler } from '../runtime/invokeHandler';
import { createTestContext } from '../runtime/createContext';
import type { FaapiContext, ResponseMeta } from '../runtime/contextTypes';
import type { HelmetOptions } from './helmet';

/**
 * helmet 中间件测试
 *
 * 覆盖：
 * - 默认配置：13 个安全头全部按 DEFAULTS 设置
 * - opt-out：单个头通过 false 关闭
 * - 自定义值：覆盖默认值
 * - 全部关闭：所有支持 false 的头同时关闭
 * - 调用 next()：headers 设置后正确传递控制权
 */
describe('helmet middleware', () => {
  const makeCtx = () => createTestContext({ method: 'GET', path: '/api/test' });

  /** 调用 helmet，返回 ctx（headers 已写入 meta） */
  async function runHelmet(opts?: HelmetOptions) {
    const mw = helmet(opts);
    // createTestContext 内部构造 ctx 时已挂载 meta（ResponseMeta），但公共类型 FaapiContext 不暴露 meta
    // 此处断言以读取中间件写入的响应头元数据（与 cors.test.ts 一致的处理方式）
    const ctx = makeCtx() as FaapiContext & { meta: ResponseMeta };
    const handler = () => ({ ok: true });
    const response = await invokeHandler(handler, ctx, undefined, [mw]);
    return { ctx, response };
  }

  describe('默认配置（13 个安全头）', () => {
    it('设置 Content-Security-Policy 默认值', async () => {
      const { ctx } = await runHelmet();
      expect(ctx.meta.headers['Content-Security-Policy']).toBe("default-src 'self'");
    });

    it('设置 X-Frame-Options 默认值 SAMEORIGIN', async () => {
      const { ctx } = await runHelmet();
      expect(ctx.meta.headers['X-Frame-Options']).toBe('SAMEORIGIN');
    });

    it('设置 X-Content-Type-Options 为 nosniff', async () => {
      const { ctx } = await runHelmet();
      expect(ctx.meta.headers['X-Content-Type-Options']).toBe('nosniff');
    });

    it('设置 Referrer-Policy 默认值', async () => {
      const { ctx } = await runHelmet();
      expect(ctx.meta.headers['Referrer-Policy']).toBe('no-referrer');
    });

    it('设置 Strict-Transport-Security 默认值', async () => {
      const { ctx } = await runHelmet();
      expect(ctx.meta.headers['Strict-Transport-Security']).toBe(
        'max-age=31536000; includeSubDomains',
      );
    });

    it('设置 X-DNS-Prefetch-Control 为 off', async () => {
      const { ctx } = await runHelmet();
      expect(ctx.meta.headers['X-DNS-Prefetch-Control']).toBe('off');
    });

    it('设置 X-Download-Options 为 noopen', async () => {
      const { ctx } = await runHelmet();
      expect(ctx.meta.headers['X-Download-Options']).toBe('noopen');
    });

    it('设置 X-Permitted-Cross-Domain-Policies 默认值', async () => {
      const { ctx } = await runHelmet();
      expect(ctx.meta.headers['X-Permitted-Cross-Domain-Policies']).toBe('none');
    });

    it('设置 Cross-Origin-Opener-Policy 默认值', async () => {
      const { ctx } = await runHelmet();
      expect(ctx.meta.headers['Cross-Origin-Opener-Policy']).toBe('same-origin');
    });

    it('设置 Cross-Origin-Resource-Policy 默认值', async () => {
      const { ctx } = await runHelmet();
      expect(ctx.meta.headers['Cross-Origin-Resource-Policy']).toBe('same-origin');
    });

    it('默认不设置 Cross-Origin-Embedder-Policy（默认 false）', async () => {
      const { ctx } = await runHelmet();
      expect(ctx.meta.headers['Cross-Origin-Embedder-Policy']).toBeUndefined();
    });

    it('设置 Origin-Agent-Cluster 为 ?1', async () => {
      const { ctx } = await runHelmet();
      expect(ctx.meta.headers['Origin-Agent-Cluster']).toBe('?1');
    });

    it('设置 X-Powered-By 为 faapi', async () => {
      const { ctx } = await runHelmet();
      expect(ctx.meta.headers['X-Powered-By']).toBe('faapi');
    });
  });

  describe('opt-out（关闭单个头）', () => {
    it('contentSecurityPolicy: false 跳过 CSP', async () => {
      const { ctx } = await runHelmet({ contentSecurityPolicy: false });
      expect(ctx.meta.headers['Content-Security-Policy']).toBeUndefined();
    });

    it('xFrameOptions: false 跳过 X-Frame-Options', async () => {
      const { ctx } = await runHelmet({ xFrameOptions: false });
      expect(ctx.meta.headers['X-Frame-Options']).toBeUndefined();
    });

    it('xContentTypeOptions: false 跳过 X-Content-Type-Options', async () => {
      const { ctx } = await runHelmet({ xContentTypeOptions: false });
      expect(ctx.meta.headers['X-Content-Type-Options']).toBeUndefined();
    });

    it('referrerPolicy: false 跳过 Referrer-Policy', async () => {
      const { ctx } = await runHelmet({ referrerPolicy: false });
      expect(ctx.meta.headers['Referrer-Policy']).toBeUndefined();
    });

    it('strictTransportSecurity: false 跳过 HSTS', async () => {
      const { ctx } = await runHelmet({ strictTransportSecurity: false });
      expect(ctx.meta.headers['Strict-Transport-Security']).toBeUndefined();
    });

    it('xDnsPrefetchControl: false 跳过 X-DNS-Prefetch-Control', async () => {
      const { ctx } = await runHelmet({ xDnsPrefetchControl: false });
      expect(ctx.meta.headers['X-DNS-Prefetch-Control']).toBeUndefined();
    });

    it('xDownloadOptions: false 跳过 X-Download-Options', async () => {
      const { ctx } = await runHelmet({ xDownloadOptions: false });
      expect(ctx.meta.headers['X-Download-Options']).toBeUndefined();
    });

    it('xPermittedCrossDomainPolicies: false 跳过 X-Permitted-Cross-Domain-Policies', async () => {
      const { ctx } = await runHelmet({ xPermittedCrossDomainPolicies: false });
      expect(ctx.meta.headers['X-Permitted-Cross-Domain-Policies']).toBeUndefined();
    });

    it('crossOriginOpenerPolicy: false 跳过 Cross-Origin-Opener-Policy', async () => {
      const { ctx } = await runHelmet({ crossOriginOpenerPolicy: false });
      expect(ctx.meta.headers['Cross-Origin-Opener-Policy']).toBeUndefined();
    });

    it('crossOriginResourcePolicy: false 跳过 Cross-Origin-Resource-Policy', async () => {
      const { ctx } = await runHelmet({ crossOriginResourcePolicy: false });
      expect(ctx.meta.headers['Cross-Origin-Resource-Policy']).toBeUndefined();
    });

    it('originAgentCluster: false 跳过 Origin-Agent-Cluster', async () => {
      const { ctx } = await runHelmet({ originAgentCluster: false });
      expect(ctx.meta.headers['Origin-Agent-Cluster']).toBeUndefined();
    });

    it('xPoweredBy: false 跳过 X-Powered-By', async () => {
      const { ctx } = await runHelmet({ xPoweredBy: false });
      expect(ctx.meta.headers['X-Powered-By']).toBeUndefined();
    });
  });

  describe('自定义值覆盖默认值', () => {
    it('自定义 contentSecurityPolicy', async () => {
      const { ctx } = await runHelmet({
        contentSecurityPolicy: "default-src 'self'; script-src 'self'",
      });
      expect(ctx.meta.headers['Content-Security-Policy']).toBe(
        "default-src 'self'; script-src 'self'",
      );
    });

    it('自定义 xFrameOptions: DENY', async () => {
      const { ctx } = await runHelmet({ xFrameOptions: 'DENY' });
      expect(ctx.meta.headers['X-Frame-Options']).toBe('DENY');
    });

    it('自定义 referrerPolicy', async () => {
      const { ctx } = await runHelmet({ referrerPolicy: 'strict-origin-when-cross-origin' });
      expect(ctx.meta.headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    });

    it('自定义 strictTransportSecurity', async () => {
      const { ctx } = await runHelmet({ strictTransportSecurity: 'max-age=63072000' });
      expect(ctx.meta.headers['Strict-Transport-Security']).toBe('max-age=63072000');
    });

    it('自定义 xPermittedCrossDomainPolicies', async () => {
      const { ctx } = await runHelmet({ xPermittedCrossDomainPolicies: 'master-only' });
      expect(ctx.meta.headers['X-Permitted-Cross-Domain-Policies']).toBe('master-only');
    });

    it('启用默认关闭的 crossOriginEmbedderPolicy', async () => {
      const { ctx } = await runHelmet({ crossOriginEmbedderPolicy: 'require-corp' });
      expect(ctx.meta.headers['Cross-Origin-Embedder-Policy']).toBe('require-corp');
    });

    it('自定义 crossOriginOpenerPolicy', async () => {
      const { ctx } = await runHelmet({ crossOriginOpenerPolicy: 'same-origin-allow-popups' });
      expect(ctx.meta.headers['Cross-Origin-Opener-Policy']).toBe('same-origin-allow-popups');
    });

    it('自定义 crossOriginResourcePolicy', async () => {
      const { ctx } = await runHelmet({ crossOriginResourcePolicy: 'cross-origin' });
      expect(ctx.meta.headers['Cross-Origin-Resource-Policy']).toBe('cross-origin');
    });
  });

  describe('全部关闭', () => {
    it('所有支持 false 的头同时关闭，仅剩 X-Content-Type-Options（boolean true 无法关闭默认值外的行为）', async () => {
      const { ctx } = await runHelmet({
        contentSecurityPolicy: false,
        xFrameOptions: false,
        xContentTypeOptions: false,
        referrerPolicy: false,
        strictTransportSecurity: false,
        xDnsPrefetchControl: false,
        xDownloadOptions: false,
        xPermittedCrossDomainPolicies: false,
        crossOriginOpenerPolicy: false,
        crossOriginResourcePolicy: false,
        crossOriginEmbedderPolicy: false,
        originAgentCluster: false,
        xPoweredBy: false,
      });
      expect(Object.keys(ctx.meta.headers)).toHaveLength(0);
    });
  });

  describe('next() 调用', () => {
    it('设置头后调用 next() 传递控制权，handler 正常执行', async () => {
      const { response } = await runHelmet();
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ data: { ok: true } });
    });
  });
});
