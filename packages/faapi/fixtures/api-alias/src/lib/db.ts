/**
 * 模拟业务方的数据库模块（通过 @/ 别名引用）
 *
 * 真实场景：业务方 handler 用 `import { db } from '@/lib/db'`，
 * vitest 下 vi.importActual 走 Vite pipeline 能识别此别名。
 */
export const db = {
  user: {
    id: 'real-user-id',
    username: 'real-user',
    nickname: '真实用户',
  },
  /** 测试 vi.mock 是否生效的标记：真实值为 'real'，mock 后为 'mocked' */
  source: 'real',
};

export interface User {
  id: string;
  username: string;
  nickname: string;
}

export async function findUser(id: string): Promise<User | undefined> {
  if (id === db.user.id) return db.user;
  return undefined;
}
