// 超时任务 fixture：run 依赖 taskCtx.signal 在超时时退出（配合型取消——宽限期内自行退出）
export const task = {
  timeoutMs: 300,
};

export function run(_payload: unknown, taskCtx: { signal: AbortSignal }): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve('never'), 10_000);
    taskCtx.signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(taskCtx.signal.reason);
    });
  });
}
