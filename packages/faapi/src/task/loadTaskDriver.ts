import { createMemoryDriver } from './memoryDriver';
import type { TaskDriver } from './driverTypes';

/**
 * 按 config.task.driver 解析并加载任务队列驱动
 *
 * - 未设置 / `'memory'` → 内置 memoryDriver（零依赖）
 * - `'pgboss'` → 动态加载子包 `@faapi/task-pgboss` 的 `createPgBossDriver(options)`
 * - `'bullmq'` → 动态加载子包 `@faapi/task-bullmq` 的 `createBullMQDriver(options)`
 * - TaskDriver 对象 → 直接使用（编程式自定义驱动）
 * - 其他值 → 显式抛错，不静默降级
 *
 * 子包 specifier 用变量拼接（`'@faapi/task-' + name`）而非字面量——主包不依赖
 * 驱动子包，运行时从业务方 node_modules 解析（与 zod peerDependency 同策略）。
 * 未安装时抛出带安装指引的错误，不静默回退 memory。
 */
export async function loadTaskDriver(
  driver: string | TaskDriver | undefined,
  driverOptions: unknown,
): Promise<TaskDriver> {
  if (driver === undefined || driver === 'memory') {
    return createMemoryDriver();
  }
  if (typeof driver === 'object') {
    return driver; // 自定义驱动实例（编程式场景）
  }
  if (driver !== 'pgboss' && driver !== 'bullmq') {
    throw new Error(
      `[faapi] Unknown task driver "${driver}". Supported: 'memory' (default), 'pgboss', 'bullmq', or a TaskDriver instance.`,
    );
  }

  const specifier = `@faapi/task-${driver}`;
  let mod: Record<string, unknown>;
  try {
    mod = (await import(/* @vite-ignore */ specifier)) as Record<string, unknown>;
  } catch {
    throw new Error(
      `[faapi] Task driver "${driver}" requires package "${specifier}" to be installed in your project.`,
    );
  }
  const factoryName = driver === 'pgboss' ? 'createPgBossDriver' : 'createBullMQDriver';
  const factory = mod[factoryName];
  if (typeof factory !== 'function') {
    throw new Error(
      `[faapi] Package "${specifier}" does not export ${factoryName}() — check the package version.`,
    );
  }
  return (factory as (options: unknown) => TaskDriver)(driverOptions);
}
