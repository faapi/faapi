/**
 * watcher 重建调度器
 *
 * 收敛 watcher 的调度逻辑：debounce 合并、重入保护、失败回灌。
 * 行为定义见 ./rebuildScheduler.md。
 */

export interface RebuildScheduler {
  /** 文件变化/新增：加入待编译集合并调度重建 */
  addFiles(files: string[]): void;
  /** 仅调度重建（如 unlink，无文件可编译） */
  schedule(): void;
}

export interface RebuildSchedulerOptions {
  /**
   * 重建回调，接收本轮待编译文件列表（可能为空数组——纯结构变化场景）
   *
   * 抛错时该轮文件回灌待编译集合（不主动重试），错误经 onError 上报。
   */
  rebuild: (files: string[]) => Promise<void>;
  /** debounce 窗口（毫秒），默认 100 */
  debounceMs?: number;
  /** 重建失败回调（如 console.error） */
  onError?: (err: unknown) => void;
}

/**
 * 创建重建调度器
 *
 * - debounce 窗口内的事件合并为一轮重建
 * - 重建进行中不重入：新事件累积文件并标记补跑，当前轮结束后串行补跑
 * - 回调抛错：文件回灌 + onError 上报，等待下一次事件自然触发（不主动重试，
 *   避免语法错误场景每 100ms 刷一次错误）
 */
export function createRebuildScheduler(options: RebuildSchedulerOptions): RebuildScheduler {
  const { rebuild, debounceMs = 100, onError } = options;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingFiles: string[] = [];
  let isRebuilding = false;
  let needsAnotherRun = false;

  async function run(): Promise<void> {
    // 重入保护：重建进行中只标记补跑，当前轮结束时串行补跑
    if (isRebuilding) {
      needsAnotherRun = true;
      return;
    }
    isRebuilding = true;
    try {
      // 串行补跑循环：每轮取走当前累积的文件，期间新事件再标记补跑
      do {
        needsAnotherRun = false;
        const files = pendingFiles;
        pendingFiles = [];
        try {
          await rebuild(files);
        } catch (err) {
          // 失败回灌：合并回待编译集合，等下次文件事件一起编译（不主动重试）
          pendingFiles = [...files, ...pendingFiles];
          onError?.(err);
        }
      } while (needsAnotherRun);
    } finally {
      isRebuilding = false;
    }
  }

  function scheduleDebounce(): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void run();
    }, debounceMs);
  }

  function requestRun(): void {
    // 重入保护：重建进行中只标记补跑（不等 debounce——重建耗时已天然
    // 合并连续事件），当前轮 while 循环结束时立即串行补跑
    if (isRebuilding) {
      needsAnotherRun = true;
      return;
    }
    scheduleDebounce();
  }

  return {
    addFiles(files) {
      pendingFiles.push(...files);
      requestRun();
    },
    schedule() {
      requestRun();
    },
  };
}
