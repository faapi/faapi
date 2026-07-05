# 场景:响应格式化

## 何时加载

用户要配置 responseFormat（统一响应包装）或 errorFormat（错误响应格式）。

## responseFormat — 统一响应包装

handler 返回的对象自动包装:

```ts
export default {
  responseFormat(data) {
    return { code: 0, data, message: 'success' };
  },
} satisfies FaapiConfig;
```

```ts
// handler
export function GET() {
  return { name: 'foo' };
}
// 实际响应: { code: 0, data: { name: 'foo' }, message: 'success' }
```

**不包装的情况**:
- handler 返回 `Response` 对象
- handler 返回 `ctx.json()`/`ctx.html()`/`ctx.redirect()` 结果
- SSE 响应(`ctx.sse()`)
- 抛错(走 errorFormat)

## errorFormat — 错误响应格式

优先于内置 `formatErrorResponse` 处理错误。返回 `Response` 表示已处理；返回 `null`/`undefined` 表示不处理,由内置 `formatErrorResponse` 兜底:

```ts
export default {
  errorFormat(err) {
    // 仅处理关心的错误,其余返回 null 交给框架兜底
    if (!(err instanceof ValidationError)) return null;
    return new Response(
      JSON.stringify({ code: 422, message: err.message }),
      { status: 422, headers: { 'Content-Type': 'application/json' } },
    );
  },
} satisfies FaapiConfig;
```

也可全量处理(返回 `Response` 即可):

```ts
export default {
  errorFormat(err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = (err as any)?.statusCode ?? 500;
    return new Response(
      JSON.stringify({ code: status, data: null, message }),
      { status, headers: { 'Content-Type': 'application/json' } },
    );
  },
} satisfies FaapiConfig;
```

**错误兜底链**:
1. `errorFormat` 返回 `Response` → 已处理
2. `errorFormat` 返回 `null`/`undefined`(未处理)或抛错 → 内置 `formatErrorResponse` 兜底
3. 内置兜底仍失败 → 最简 500

## 检查清单

- [ ] responseFormat 返回 Response 或对象
- [ ] errorFormat 返回 Response 或 null/undefined(未处理时)
