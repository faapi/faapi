// 超时任务 fixture：验证隔离执行的真终止——run 刻意不配合取消（不监听 signal），
// 只能靠 graceMs 宽限期到点后的 terminate() 硬杀结束（任务自然结束需 10s）。
// timeoutMs 最小 60s（扫描期校验）；e2e 经驱动停机 abort 触发两段式取消
export const task = {
  timeoutMs: 60_000,
  graceMs: 500,
};

export function run(): Promise<string> {
  return new Promise((resolve) => {
    setTimeout(() => resolve('never'), 10_000);
  });
}
