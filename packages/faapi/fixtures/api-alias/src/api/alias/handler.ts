/**
 * 用 @/ 别名引用 lib 模块的 handler
 *
 * 模拟 sso 项目的场景：handler 内 `import { db } from '@/lib/db'`，
 * 在 vitest 下 createTestServer 加载此 handler 时，需要走 Vite pipeline
 * 才能识别 @/ 别名 + 让 vi.mock 生效。
 */
import { db, findUser } from '@/lib/db';

export interface Query {
  id?: string;
}

export function GET(query: Query) {
  if (query.id) {
    const user = findUserSync(query.id);
    if (!user) return { source: db.source, user: null };
    return { source: db.source, user };
  }
  return { source: db.source, user: db.user };
}

// 同步包装，便于 handler 直接返回
function findUserSync(id: string) {
  // 简化：直接比对 id，真实场景应走 db.findUser
  if (id === db.user.id) return db.user;
  return undefined;
}
