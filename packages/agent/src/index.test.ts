import { describe, it, expect } from 'vitest';
import {
  createRollingSummaryCompactor,
  AgentError,
  AgentToolTimeoutError,
  AgentRecursionError,
} from './index';

/**
 * 主入口公开导出防回归（src/index.ts）
 *
 * 惯例同主包 index.test.ts：公开导出的函数/类必须有入口级断言兜底，
 * 防模块级测试全绿但发布包 import 为 undefined。
 */

describe('主入口公开导出（历史压缩）', () => {
  it('createRollingSummaryCompactor 可调用并产出 plan/fold/block', () => {
    expect(typeof createRollingSummaryCompactor).toBe('function');
    const compactor = createRollingSummaryCompactor({ complete: async (input) => input });
    expect(typeof compactor.plan).toBe('function');
    expect(typeof compactor.fold).toBe('function');
    expect(typeof compactor.block).toBe('function');
  });

  it('错误家族与类型导出可用（AgentError 经 agentErrors 持有、agent re-export）', () => {
    expect(typeof AgentError).toBe('function');
    expect(typeof AgentToolTimeoutError).toBe('function');
    expect(typeof AgentRecursionError).toBe('function');
    expect(new AgentError('x')).toBeInstanceOf(Error);
  });
});
