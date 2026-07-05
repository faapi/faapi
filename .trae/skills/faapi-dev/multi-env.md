# 场景:多环境配置

## 何时加载

用户要写生产环境配置覆盖（`faapi.config.production.ts`）或理解环境决定逻辑。

## 环境决定规则

环境由 `FAAPI_ENV` 或 `NODE_ENV` 决定(默认 `development`),优先级 `FAAPI_ENV > NODE_ENV > 'development'`。

## 使用方式

```ts
// faapi.config.ts — 基础配置
export default {
  db: { host: 'localhost', port: 5432 },
} satisfies FaapiConfig;

// faapi.config.production.ts — 生产环境覆盖
export default {
  db: { host: 'db.production.com', port: 5432 },
} satisfies FaapiConfig;
```

环境配置与基础配置**深度合并**,环境配置优先。

## 环境文件命名

```
faapi.config.ts              # 基础（默认 development）
faapi.config.development.ts  # 开发环境覆盖
faapi.config.production.ts   # 生产环境覆盖
faapi.config.test.ts         # 测试环境覆盖
```
