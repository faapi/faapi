# 场景:扩展 ctx

## 何时加载

用户要给 `ctx` 挂载自定义方法（如 i18n、工具函数）。

## 配置方式

```ts
export default {
  extendContext(ctx) {
    ctx.t = (key: string) => key;          // i18n
    ctx.now = () => Date.now();
  },
} satisfies FaapiConfig;
```

配合 `declare module` 增强类型:

```ts
// types.ts(项目任意位置)
declare module '@faapi/faapi' {
  interface FaapiContext {
    t: (key: string) => string;
    now: () => number;
    user?: { id: number; name: string };
  }
}
```

## 常见坑点

```ts
// ❌ 运行时报错:ctx.t is not a function
export default {
  extendContext(ctx) {
    // 没有挂载 t,但 handler 用了
  },
};

// ✅
export default {
  extendContext(ctx) {
    ctx.t = (key: string) => key;
  },
};
```
