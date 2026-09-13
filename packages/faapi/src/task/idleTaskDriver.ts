import type { TaskDriver } from './driverTypes';

/**
 * 空闲占位驱动（无任务清单时的队列驱动）
 *
 * 注册表为空时 createAppBase 用本驱动创建队列，零任务项目无需安装驱动子包；
 * 占位驱动不提供任何存储语义——enqueue 显式报错（覆盖 dev reloadTasks 后
 * 新增任务、驱动仍是占位的场景），避免"看似有队列实则无驱动"的静默降级。
 */
export function createIdleTaskDriver(): TaskDriver {
  return {
    enqueue() {
      return Promise.reject(
        new Error(
          "[faapi] New task(s) were registered without a queue driver. Set config.task.driver to 'pgboss' or 'bullmq' (install the matching @faapi/task-* package) and restart the server.",
        ),
      );
    },
    startWorker() {
      // 无任务清单：不注册任何消费
    },
    async stop() {
      // 无任务清单：无 in-flight，立即返回
    },
    async stopWorkers() {
      // 无任务清单：无 worker 可停
    },
  };
}
