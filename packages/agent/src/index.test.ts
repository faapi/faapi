import { describe, it, expect } from 'vitest';
import { AgentError, AgentToolTimeoutError, AgentRecursionError } from './index';

/**
 * 主入口公开导出防回归（src/index.ts）
 *
 * 惯例同主包 index.test.ts：公开导出的函数/类必须有入口级断言兜底，
 * 防模块级测试全绿但发布包 import 为 undefined。
 */

describe('主入口公开导出（历史压缩）', () => {
  it('滚动摘要配方组件已整体移除，不再公开导出（防回归复活）', async () => {
    const mod = await import('./index');
    expect('createRollingSummaryCompactor' in mod).toBe(false);
    expect('RollingSummaryOptions' in mod).toBe(false);
    expect('RollingSummaryCompactor' in mod).toBe(false);
    expect('FoldPlan' in mod).toBe(false);
    expect('SummaryComplete' in mod).toBe(false);
  });

  it('错误家族与类型导出可用（AgentError 经 agentErrors 持有、agent re-export）', () => {
    expect(typeof AgentError).toBe('function');
    expect(typeof AgentToolTimeoutError).toBe('function');
    expect(typeof AgentRecursionError).toBe('function');
    expect(new AgentError('x')).toBeInstanceOf(Error);
  });
});
