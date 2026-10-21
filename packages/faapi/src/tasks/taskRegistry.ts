import type { TaskMetadata } from './taskTypes';

/**
 * app 实例级任务注册表（与 tool/agent/skill registry 同构，方案 A 实例化）
 *
 * 任务清单来自编译期产物（faapi-tasks.js），reload 时整体替换（hydrate 语义）。
 * 每个 app 持有独立实例，多 app 同进程互不串台；详见 taskRegistry.md。
 */
export interface TaskRegistry {
  /** 全量替换（任务清单来自编译期产物，reload 时整体重新生成） */
  hydrate(tasks: TaskMetadata[]): void;
  /** 按任务名查找 */
  get(name: string): TaskMetadata | undefined;
  /** 所有已注册任务（副本） */
  list(): TaskMetadata[];
  clear(): void;
}

export function createTaskRegistry(): TaskRegistry {
  let registry = new Map<string, TaskMetadata>();
  return {
    hydrate(tasks) {
      const next = new Map<string, TaskMetadata>();
      for (const task of tasks) {
        next.set(task.name, task);
      }
      registry = next;
    },
    get(name) {
      return registry.get(name);
    },
    list() {
      return Array.from(registry.values());
    },
    clear() {
      registry = new Map();
    },
  };
}
