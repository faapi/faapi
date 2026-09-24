/**
 * 浏览器端统一请求入口:fetch 封装 + 非 JSON 响应守卫 + faapi 信封解包。
 *
 * 守卫动机:/api/* 的错误响应恒为 JSON 信封,但链路其他层会返回 HTML——
 * 反代/网关错误页(502/504)、Next.js 404 页、SSO 登录守卫 302(fetch 跟随
 * 重定向拿到登录页)。直接 res.json() 会把裸 SyntaxError 原文抛进界面;
 * 这里检测 + 转译为结构化 ApiError,现场留在 console。行为规格见 apiCall.md。
 */
import { ApiError, type ApiEnvelope } from './apiError';

/**
 * 非 JSON 响应(反代错误页/空 body)按状态映射的可行动中文文案。
 *
 * 导出供业务方 fork 自定义文案(如英文产品)时组合使用。
 */
export function statusMessage(status: number): string {
  if (status === 504) return '服务响应超时,请稍后重试';
  if (status === 502 || status === 503) return '服务暂时不可用,请稍后重试';
  if (status === 401) return '登录已过期,请刷新页面重新登录';
  return `请求失败: ${status}`;
}

/**
 * 发起 API 请求并解包 faapi 默认信封,失败一律抛 ApiError。
 *
 * 成功返回 body.data;非 JSON/信封错误/空响应转译为结构化错误,
 * 现场经 console.error 保留(status/url/body 前 200 字符)。
 * 仅支持主包 config.response 默认信封,自定义信封时业务方自行包装。
 */
export async function apiCall<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, init);
  const text = await res.text();

  let body: ApiEnvelope<T>;
  try {
    body = JSON.parse(text) as ApiEnvelope<T>;
  } catch {
    // 非 JSON 响应:现场留给排障,错误转译为可行动的文案。
    console.error('[apiCall] 非 JSON 响应', {
      status: res.status,
      url: res.url,
      body: text.slice(0, 200),
    });
    if (res.redirected) {
      // fetch 跟随重定向后拿到非 JSON(典型:SSO 登录守卫 302 → 登录页)
      throw new ApiError('REDIRECTED', res.status, '登录状态已失效，请刷新页面重新登录');
    }
    throw new ApiError('NON_JSON_RESPONSE', res.status, statusMessage(res.status));
  }

  if (!res.ok || body.error) {
    throw new ApiError(
      body.error?.code ?? 'HTTP_ERROR',
      res.status,
      body.error?.message || statusMessage(res.status),
      body.error?.issues,
    );
  }

  if (body.data === undefined) {
    // {data: null} 合法返回 null;无 data 字段({})视为空响应错误
    throw new ApiError('EMPTY_RESPONSE', res.status, `请求失败: ${res.status}`);
  }

  return body.data;
}
