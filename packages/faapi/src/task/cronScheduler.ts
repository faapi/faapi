import { Cron } from 'croner';
import type { TaskRegistry } from './taskRegistry';

/**
 * cron 定时入队调度器
 *
 * 为注册表中声明了 `cron` 的任务建立 croner 定时器，到点调用 `enqueue(name)`
 * 投递空 payload——定时只是"自动投递者"，复用队列的重试/并发/停机语义。
 * 详见 cronScheduler.md。
 */
export interface CronScheduler {
  /** 建立全部 cron 定时器（幂等——重复调用先清理旧定时器） */
  start(): void;
  /** 停止全部定时器（幂等） */
  stop(): void;
}

export function createCronScheduler(
  registry: TaskRegistry,
  enqueue: (name: string) => Promise<unknown>,
): CronScheduler {
  let schedules: Cron[] = [];

  return {
    start() {
      this.stop();
      for (const task of registry.list()) {
        if (!task.cron) continue;
        // croner 对非法表达式抛错——启动期显式失败，不静默跳过（cronScheduler.md 约定）
        schedules.push(
          new Cron(task.cron, () => {
            void Promise.resolve()
              .then(() => enqueue(task.name))
              .catch((err) => {
                console.error(`[faapi] Cron enqueue failed for task "${task.name}":`, err);
              });
          }),
        );
      }
    },

    stop() {
      for (const schedule of schedules) {
        schedule.stop();
      }
      schedules = [];
    },
  };
}
