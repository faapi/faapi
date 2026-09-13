import { describe, it, expect } from 'vitest';
import { createTaskRegistry } from './taskRegistry';
import type { TaskMetadata } from './taskTypes';

const meta = (name: string, extra: Partial<TaskMetadata> = {}): TaskMetadata => ({
  name,
  filePath: `dist/tasks/${name}/task.js`,
  ...extra,
});

describe('createTaskRegistry', () => {
  it('hydrate 整体替换语义', () => {
    const reg = createTaskRegistry();
    reg.hydrate([meta('a'), meta('b')]);
    reg.hydrate([meta('c')]);
    expect(reg.list().map((t) => t.name)).toEqual(['c']);
  });

  it('get 命中与未命中', () => {
    const reg = createTaskRegistry();
    reg.hydrate([meta('a', { cron: '0 3 * * *' })]);
    expect(reg.get('a')?.cron).toBe('0 3 * * *');
    expect(reg.get('nope')).toBeUndefined();
  });

  it('list 返回新数组（元素与注册表共享引用，与 toolRegistry 约定一致）', () => {
    const reg = createTaskRegistry();
    reg.hydrate([meta('a')]);
    const snapshot = reg.list();
    expect(snapshot).not.toBe(reg.list());
    snapshot.length = 0;
    expect(reg.get('a')).toBeDefined();
  });

  it('clear 清空', () => {
    const reg = createTaskRegistry();
    reg.hydrate([meta('a')]);
    reg.clear();
    expect(reg.list()).toEqual([]);
    expect(reg.get('a')).toBeUndefined();
  });
});
