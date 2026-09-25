import { describe, it, expect, vi, afterEach } from 'vitest';
import { apiCall, statusMessage } from './apiCall';
import { ApiError } from './apiError';

/** JSON 响应 stub */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** HTML 错误页 stub（反代/Next 404 页形态） */
function htmlResponse(body: string, status: number): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/html' } });
}

/**
 * redirected 场景 stub:Response.redirected 由 fetch runtime 设置(只读),
 * 构造不出,用普通对象模拟 apiCall 消费的字段。
 */
function redirectedResponse(status = 200): Response {
  return {
    ok: true,
    status,
    redirected: true,
    url: 'http://localhost/login',
    text: () => Promise.resolve('<html><head><title>登录</title></head></html>'),
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('statusMessage', () => {
  it('504 → 服务响应超时', () => {
    expect(statusMessage(504)).toBe('服务响应超时,请稍后重试');
  });

  it('502/503 → 服务暂时不可用', () => {
    expect(statusMessage(502)).toBe('服务暂时不可用,请稍后重试');
    expect(statusMessage(503)).toBe('服务暂时不可用,请稍后重试');
  });

  it('401 → 登录已过期', () => {
    expect(statusMessage(401)).toBe('登录已过期,请刷新页面重新登录');
  });

  it('其余状态 → 请求失败: status', () => {
    expect(statusMessage(404)).toBe('请求失败: 404');
    expect(statusMessage(500)).toBe('请求失败: 500');
  });
});

describe('apiCall', () => {
  it('成功:解包 {data} 返回 data', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ data: { id: 1, name: 'foo' } })),
    );
    await expect(apiCall<{ id: number; name: string }>('/api/user')).resolves.toEqual({
      id: 1,
      name: 'foo',
    });
  });

  it('{data: null} 合法返回 null,不误伤', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ data: null })),
    );
    await expect(apiCall<null>('/api/user')).resolves.toBeNull();
  });

  it('HTML 502(反代错误页) → ApiError NON_JSON_RESPONSE + 服务暂时不可用', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => htmlResponse('<html><body><h1>502 Bad Gateway</h1></body></html>', 502)),
    );
    const err = await apiCall('/api/user').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('NON_JSON_RESPONSE');
    expect((err as ApiError).status).toBe(502);
    expect((err as ApiError).message).toBe('服务暂时不可用,请稍后重试');
  });

  it('合法 JSON 但非对象形态(null/数字) → NON_JSON_RESPONSE,不抛裸 TypeError', async () => {
    // 回归:JSON.parse("null") === null,此前 body.error 访问抛
    // "Cannot read properties of null",击穿「失败一律转 ApiError」承诺
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(null, 200)),
    );
    await expect(apiCall('/api/x')).rejects.toMatchObject({ code: 'NON_JSON_RESPONSE' });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(42, 200)),
    );
    await expect(apiCall('/api/x')).rejects.toMatchObject({ code: 'NON_JSON_RESPONSE' });
  });

  it('HTML 404(Next 404 页) → NON_JSON_RESPONSE + 请求失败: 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => htmlResponse('<html><body><h1>404</h1></body></html>', 404)),
    );
    const err = await apiCall('/api/user').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('NON_JSON_RESPONSE');
    expect((err as ApiError).message).toBe('请求失败: 404');
  });

  it('HTML 504(网关超时) → 服务响应超时', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        htmlResponse('<html><body><h1>504 Gateway Timeout</h1></body></html>', 504),
      ),
    );
    const err = await apiCall('/api/user').catch((e) => e);
    expect((err as ApiError).message).toBe('服务响应超时,请稍后重试');
  });

  it('HTML 401 且未重定向 → 登录已过期', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => htmlResponse('<html><body><h1>401</h1></body></html>', 401)),
    );
    const err = await apiCall('/api/user').catch((e) => e);
    expect((err as ApiError).code).toBe('NON_JSON_RESPONSE');
    expect((err as ApiError).message).toBe('登录已过期,请刷新页面重新登录');
  });

  it('SSO 登录页重定向(redirected 非 JSON) → ApiError REDIRECTED + 登录状态已失效', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => redirectedResponse()),
    );
    const err = await apiCall('/api/user').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('REDIRECTED');
    expect((err as ApiError).message).toBe('登录状态已失效，请刷新页面重新登录');
  });

  it('非 JSON 时 console.error 保留现场:status/url/body 前 200 字符', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const longBody = '<html><body>' + 'x'.repeat(300) + '</body></html>';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => htmlResponse(longBody, 502)),
    );
    await apiCall('/api/user').catch(() => {});
    expect(spy).toHaveBeenCalledTimes(1);
    const [label, field] = spy.mock.calls[0];
    expect(label).toBe('[apiCall] 非 JSON 响应');
    expect(field.status).toBe(502);
    expect(field.url).toBeTypeOf('string');
    expect(field.body).toBe(longBody.slice(0, 200));
    expect(field.body).toHaveLength(200);
  });

  it('空 body → NON_JSON_RESPONSE', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => htmlResponse('', 500)),
    );
    const err = await apiCall('/api/user').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('NON_JSON_RESPONSE');
    expect((err as ApiError).message).toBe('请求失败: 500');
  });

  it('JSON 500:透传信封 error.code/status/message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ error: { code: 'INTERNAL_ERROR', message: '服务器内部错误' } }, 500),
      ),
    );
    const err = await apiCall('/api/user').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('INTERNAL_ERROR');
    expect((err as ApiError).status).toBe(500);
    expect((err as ApiError).message).toBe('服务器内部错误');
  });

  it('JSON 200 但带 error → 抛 ApiError(body.error 优先于 res.ok)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ error: { code: 'PERMISSION_DENIED', message: '禁止访问' } }, 200),
      ),
    );
    const err = await apiCall('/api/user').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('PERMISSION_DENIED');
    expect((err as ApiError).message).toBe('禁止访问');
  });

  it('JSON 200 但 {} 无 data 字段 → ApiError EMPTY_RESPONSE', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({})),
    );
    const err = await apiCall('/api/user').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('EMPTY_RESPONSE');
    expect((err as ApiError).status).toBe(200);
    expect((err as ApiError).message).toBe('请求失败: 200');
  });

  it('VALIDATION_ERROR:issues 挂载到 err.issues', async () => {
    const issues = [
      {
        path: 'page',
        code: 'TYPE_MISMATCH',
        expected: 'number',
        received: 'string',
        message: 'page expected number, got string',
      },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ error: { code: 'VALIDATION_ERROR', message: '参数校验失败', issues } }, 422),
      ),
    );
    const err = await apiCall('/api/user').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('VALIDATION_ERROR');
    expect((err as ApiError).issues).toEqual(issues);
  });

  it('fetch 本身网络错误原样上抛(非 ApiError)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('fetch failed'))),
    );
    const err = await apiCall('/api/user').catch((e) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect(err).not.toBeInstanceOf(ApiError);
  });

  it('init 透传给 fetch,不注入默认 headers', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ data: 1 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const init: RequestInit = { method: 'POST', headers: { 'X-Custom': '1' } };
    await apiCall('/api/user', init);
    expect(fetchMock).toHaveBeenCalledWith('/api/user', init);
    // init 原样透传:未被注入额外字段
    const passed = fetchMock.mock.calls[0][1] as RequestInit;
    expect(passed).toBe(init);
    expect(Object.keys(passed.headers as Record<string, string>)).toEqual(['X-Custom']);
  });
});
