/**
 * 测试：全局注入器
 *
 * handler 声明 db 参数，由 faapi.config.ts 的全局注入器提供。
 * 无目录 middlewares.ts，验证全局注入器对无目录注入器的路由生效。
 */
export function GET(db: { query: () => string[] }) {
  return { injected: 'global-db', rows: db.query() };
}
