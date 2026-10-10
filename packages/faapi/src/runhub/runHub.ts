/**
 * runHub——交互式 run 的传输中枢
 *
 * 「run 与 HTTP 解耦 + 订阅式消费」的原语：start 注册运行、publish 进缓冲并扇出、
 * subscribe 同拍快照 + 实时接续、abort 中止、finish 即清。键（K）与事件载荷（E）
 * 泛型，持久化走可选 SPI——未提供即纯内存，提供时业务接自己的存储（多实例演进位）。
 *
 * 语义契约（冲突 / 快照同拍 / finish 即清 / 溢出 truncated / 外部事件 seq=0 /
 * append 失败留痕不杀直播）详见 [runHub.md](./runHub.md)。
 */

import { randomUUID } from 'node:crypto';
import { FaapiError } from '../errors/FaapiError';
import { RUN_CONFLICT } from '../errors/errorCodes';

/** 同键已有进行中 run 时 start 抛出（业务转 409；逃逸 HTTP 管线时自动按 409 格式化） */
export class RunConflictError extends FaapiError {
  /** 冲突的业务键 */
  readonly key: string;
  /** 已在进行中 run 的 id */
  readonly runId: string;

  constructor(key: string | number, runId: string) {
    super(RUN_CONFLICT, `Run already active for key "${key}" (runId: ${runId})`, 409);
    this.name = 'RunConflictError';
    this.key = String(key);
    this.runId = runId;
  }
}

/** hub 事件壳——seq 序号 + 事件名 + 业务载荷（载荷形状是业务知识，框架不规定不校验） */
export interface RunHubEvent<T = unknown> {
  /**
   * 每键严格单调递增、跨 run 不清零；基座为键首次触碰时刻的毫秒时间戳
   * （跨 hub 进程不碰撞，游标/去重语义依赖，见 runHub.ts seqBase 注释）。
   * 消费端按不透明单调序号对待，不做数值假设。外部直播事件恒 0。
   */
  seq: number;
  event: string;
  data: T;
}

/** 重放策略：完结轮即清不重放（默认，以库为准）| 每次订阅触发 loadSince 重放（需 persistence） */
export type RunReplayPolicy = 'inflight-only' | 'always';

/**
 * 事件持久化 SPI（可选）：未提供 = 纯内存；提供时 subscribe 支持 sinceCursor 增量，
 * 跨重启/多实例由业务存储承接。
 *
 * append 失败（同步抛错或 Promise rejection）不传播出 publish——每 hub 实例首次失败
 * console.error 留痕（不杀直播主流程，见 runHub.md）；loadSince 返回按 seq 升序的事件。
 */
export interface RunHubPersistence {
  append(key: string, event: RunHubEvent): void | Promise<void>;
  loadSince(key: string, cursor: number): Promise<RunHubEvent[]>;
}

export interface RunHubOptions {
  /** 重放缓冲上限（条），溢出丢最旧并置 truncated（默认 20000，须正整数） */
  maxBuffer?: number;
  /** 重放策略（默认 'inflight-only'；'always' 需 persistence，构造期校验） */
  replayPolicy?: RunReplayPolicy;
  /** 事件持久化 SPI（可选，见 RunHubPersistence） */
  persistence?: RunHubPersistence;
}

/** 进行中 run 的句柄——业务把它接进 LLM 流式回调与停止端点 */
export interface RunHandle {
  runId: string;
  /** 启动时间戳（毫秒，Date.now） */
  startedAt: number;
  /**
   * 业务把它挂到 LLM 请求的 AbortSignal——abort 触发既有 AgentAbortError 链路。
   * abort 不自动 finish：业务收尾持久化后自行调用 finish()。
   */
  signal: AbortSignal;
  /** 事件进缓冲 + 扇出订阅者（+ 持久化 append）；finish 后自然空操作 */
  publish(event: string, data: unknown): void;
  /**
   * 轮终态即清运行态与缓冲（定稿持久化先于本调用）；幂等。
   * 完结轮不从内存重放——订阅端以库为准（subscribe 返回 runId: null）。
   */
  finish(): void;
}

/** subscribe 的增量重放入参（需 persistence；未配置时传入显式抛错） */
export interface RunSubscribeOptions {
  /** 从该游标之后经 loadSince 增量重放（不含游标本身） */
  sinceCursor?: number;
}

/** subscribe 返回：同拍快照 + 实时订阅句柄 */
export interface RunSubscription<E> {
  /**
   * 缓冲快照（注册前已发生的全部缓冲事件）。store 重放路径（sinceCursor /
   * replayPolicy='always'）恒为空数组——全部事件经 onEvent 有序送达
   */
  events: RunHubEvent<E>[];
  /** 进行中 run 的 id；null = 无进行中 run（空闲/已完结/重启丢失）——订阅端以库为准 */
  runId: string | null;
  /** 进行中 run 的启动时间戳；无运行时 null */
  startedAt: number | null;
  /** 缓冲是否溢出过（该轮持续为 true，订阅端据标记回落业务对账）；store 重放路径恒 false */
  truncated: boolean;
  /** 退订；订阅者跨轮长存（空闲连接等下一轮 start），退订后不再收 */
  unsubscribe(): void;
}

/** createRunHub 返回的传输中枢 */
export interface RunHub<K extends string | number, E = unknown> {
  /** 注册新 run；同键已有 running 抛 RunConflictError（业务转 409） */
  start(key: K): RunHandle;
  /**
   * 同拍完成「注册 + 快照」：快照含注册前全部缓冲事件，实时通道接续其后，无缺口无重复。
   * options.sinceCursor 走持久化 SPI 增量重放（见 runHub.md「持久化 SPI」）
   */
  subscribe(
    key: K,
    onEvent: (e: RunHubEvent<E>) => void,
    options?: RunSubscribeOptions,
  ): RunSubscription<E>;
  /** 轮外直播：绕过缓冲与存储直扇当前订阅者（seq=0，刷新即失）；无订阅者时空操作 */
  publishExternal(key: K, event: string, data: E): void;
  /** 中止进行中 run（触发 handle.signal）；不自动 finish；无 running 返回 false */
  abort(key: K): boolean;
  /** 该键是否有进行中 run */
  isActive(key: K): boolean;
}

/** 默认重放缓冲上限（条） */
const DEFAULT_MAX_BUFFER = 20000;

/** 运行态：缓冲只服务进行中的一轮，finish 即清 */
interface RunState {
  runId: string;
  startedAt: number;
  controller: AbortController;
  buffer: RunHubEvent[];
  truncated: boolean;
  finished: boolean;
}

/** 键状态：seq 跨 run 单调递增不清零（持久化游标语义依赖），订阅者跨轮长存 */
interface KeyState {
  seq: number;
  run: RunState | null;
  subscribers: Set<Subscriber>;
}

/**
 * 键的 seq 基座：取键首次触碰时刻的毫秒时间戳（Redis Streams 同款方案）
 *
 * seq 必须跨 run 不清零（loadSince 游标按键定位）、跨 hub 进程不碰撞（重启/
 * 多实例下新进程的 seq 不得与存储中旧进程事件重叠，否则去重与游标失效）——
 * 小整数计数器做不到，以时钟为基座即可同时满足；同进程内同一毫秒的多事件由
 * ++ 递增保证严格递增。代价是 seq 为不连续大整数（消费端按不透明单调序号对待）。
 */
function seqBase(): number {
  return Date.now();
}

interface Subscriber {
  onEvent: (e: RunHubEvent) => void;
  active: boolean;
  /** 非 null = store 重放进行中：实时事件排队，重放批之后按到达序送达 */
  pendingReplay: { queued: RunHubEvent[] } | null;
}

/**
 * 创建 runHub 传输中枢
 *
 * @param options 全部可选；缺省为纯内存 + inflight-only（逐字节默认语义）
 * @throws {Error} maxBuffer 非正整数 / replayPolicy 非法 / replayPolicy='always' 未配 persistence
 */
export function createRunHub<K extends string | number, E = unknown>(
  options?: RunHubOptions,
): RunHub<K, E> {
  const maxBuffer = options?.maxBuffer ?? DEFAULT_MAX_BUFFER;
  if (!Number.isInteger(maxBuffer) || maxBuffer < 1) {
    throw new Error(`createRunHub: maxBuffer must be a positive integer, got ${maxBuffer}`);
  }
  const replayPolicy = options?.replayPolicy ?? 'inflight-only';
  if (replayPolicy !== 'inflight-only' && replayPolicy !== 'always') {
    throw new Error(
      `createRunHub: replayPolicy must be 'inflight-only' | 'always', got ${String(replayPolicy)}`,
    );
  }
  const persistence = options?.persistence;
  if (replayPolicy === 'always' && !persistence) {
    throw new Error(
      "createRunHub: replayPolicy 'always' requires persistence (nowhere to replay from) — declare persistence or drop the option",
    );
  }

  const keys = new Map<K, KeyState>();
  /** 每 hub 实例首次 append 失败留痕标记（异步 append 成功后复位，再次失败重新留痕） */
  let appendFailureLogged = false;

  const keyState = (key: K): KeyState => {
    let state = keys.get(key);
    if (!state) {
      state = { seq: seqBase(), run: null, subscribers: new Set() };
      keys.set(key, state);
    }
    return state;
  };

  const deliver = (sub: Subscriber, event: RunHubEvent): void => {
    try {
      sub.onEvent(event);
    } catch (err) {
      console.error('[runHub] subscriber callback threw:', err);
    }
  };

  const fanout = (state: KeyState, event: RunHubEvent): void => {
    for (const sub of state.subscribers) {
      if (!sub.active) continue;
      if (sub.pendingReplay) {
        sub.pendingReplay.queued.push(event);
        continue;
      }
      deliver(sub, event);
    }
  };

  const logAppendFailure = (key: string, err: unknown): void => {
    if (appendFailureLogged) return;
    appendFailureLogged = true;
    console.error(
      `[runHub] persistence.append failed (key: ${key}) — live stream continues, replay degraded; further failures silent until recovery:`,
      err,
    );
  };

  // append 是持久化旁路：失败留痕不传播（runHub.md「持久化 SPI」）——同步抛错与
  // Promise rejection 都不杀直播主流程；publish 保持同步 void 签名
  const appendSafely = (key: string, event: RunHubEvent): void => {
    try {
      const result = persistence!.append(key, event);
      if (result && typeof result.catch === 'function') {
        // 单链双处理器——分离的 .catch/.then 链会让 rejection 在无处理器的分支上
        // 变成 unhandled rejection
        result.then(
          () => {
            appendFailureLogged = false;
          },
          (err: unknown) => logAppendFailure(key, err),
        );
      }
    } catch (err) {
      logAppendFailure(key, err);
    }
  };

  return {
    start(key: K): RunHandle {
      const state = keyState(key);
      if (state.run) {
        throw new RunConflictError(key, state.run.runId);
      }
      const run: RunState = {
        runId: randomUUID(),
        startedAt: Date.now(),
        controller: new AbortController(),
        buffer: [],
        truncated: false,
        finished: false,
      };
      state.run = run;

      const publish = (event: string, data: unknown): void => {
        if (run.finished) return; // 终态后自然空操作
        const evt: RunHubEvent = { seq: ++state.seq, event, data };
        run.buffer.push(evt);
        if (run.buffer.length > maxBuffer) {
          run.buffer.shift();
          run.truncated = true;
        }
        if (persistence) appendSafely(String(key), evt);
        fanout(state, evt);
      };

      const finish = (): void => {
        if (run.finished) return;
        run.finished = true;
        if (state.run === run) state.run = null;
      };

      return {
        runId: run.runId,
        startedAt: run.startedAt,
        signal: run.controller.signal,
        publish,
        finish,
      };
    },

    subscribe(
      key: K,
      onEvent: (e: RunHubEvent<E>) => void,
      options?: RunSubscribeOptions,
    ): RunSubscription<E> {
      const state = keyState(key);
      const sub: Subscriber = {
        onEvent: onEvent as (e: RunHubEvent) => void,
        active: true,
        pendingReplay: null,
      };
      // 注册先于快照/重放——同拍契约的注册侧（同步执行内无插队）
      state.subscribers.add(sub);

      const unsubscribe = (): void => {
        sub.active = false;
        state.subscribers.delete(sub);
      };

      const run = state.run;
      const wantsStoreReplay = options?.sinceCursor !== undefined || replayPolicy === 'always';
      if (!wantsStoreReplay) {
        return {
          // 泛型边界单点转换：内部以 RunHubEvent<unknown> 存取,公开面按业务标注的
          // E 交付——载荷形状是业务知识,框架不规定不校验（runHub.md）
          events: (run ? [...run.buffer] : []) as RunHubEvent<E>[],
          runId: run?.runId ?? null,
          startedAt: run?.startedAt ?? null,
          truncated: run?.truncated ?? false,
          unsubscribe,
        };
      }
      if (!persistence) {
        throw new Error(
          'runHub.subscribe: sinceCursor requires persistence (no store to replay from) — declare persistence in createRunHub options or drop sinceCursor',
        );
      }

      // store 重放路径：events 恒空，重放 + 实时经 onEvent 有序去重送达（runHub.md）
      sub.pendingReplay = { queued: [] };
      const cursor = options?.sinceCursor ?? 0;
      persistence
        .loadSince(String(key), cursor)
        .then((stored) => {
          if (!sub.active || !sub.pendingReplay) return;
          const storedSeqs = new Set(stored.map((e) => e.seq));
          for (const event of stored) deliver(sub, event);
          for (const event of sub.pendingReplay.queued) {
            if (!storedSeqs.has(event.seq)) deliver(sub, event);
          }
          sub.pendingReplay = null;
        })
        .catch((err: unknown) => {
          console.error(
            `[runHub] persistence.loadSince failed (key: ${String(key)}) — replay abandoned, queued live events delivered as-is:`,
            err,
          );
          const pending = sub.pendingReplay;
          sub.pendingReplay = null;
          if (pending) {
            for (const event of pending.queued) deliver(sub, event);
          }
        });

      return {
        events: [],
        runId: run?.runId ?? null,
        startedAt: run?.startedAt ?? null,
        truncated: false,
        unsubscribe,
      };
    },

    publishExternal(key: K, event: string, data: E): void {
      const state = keys.get(key);
      if (!state) return; // 无订阅者无运行：空操作
      fanout(state, { seq: 0, event, data });
    },

    abort(key: K): boolean {
      const state = keys.get(key);
      if (!state?.run) return false;
      state.run.controller.abort(new Error(`Run aborted via hub.abort (key: ${String(key)})`));
      return true;
    },

    isActive(key: K): boolean {
      return keys.get(key)?.run != null;
    },
  };
}
