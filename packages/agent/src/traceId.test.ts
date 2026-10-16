import { describe, it, expect } from 'vitest';
import {
  createTraceSegment,
  joinTraceId,
  DEFAULT_TRACE_ID_TEMPLATE,
  buildTraceIdBlock,
} from './traceId';
import { AgentError } from './agentErrors';

describe('createTraceSegment', () => {
  it('返回 12 位十六进制段（uuid 去连字符截取,不含分隔符）', () => {
    expect(createTraceSegment()).toMatch(/^[0-9a-f]{12}$/);
  });

  it('两次调用生成不同段（随机性）', () => {
    const segments = new Set(Array.from({ length: 100 }, () => createTraceSegment()));
    expect(segments.size).toBe(100);
  });
});

describe('joinTraceId', () => {
  it('子 ID = 父完整 ID + . + 子段', () => {
    expect(joinTraceId('3f2504e0a9b8', '5e4d3c2b1a09')).toBe('3f2504e0a9b8.5e4d3c2b1a09');
  });

  it('深层链式:孙 ID 以父完整 ID 为前缀再拼新段', () => {
    const root = createTraceSegment();
    const child = joinTraceId(root, createTraceSegment());
    const grand = joinTraceId(child, createTraceSegment());
    expect(grand.startsWith(`${child}.`)).toBe(true);
    expect(grand.split('.')).toHaveLength(3);
    for (const part of grand.split('.')) {
      expect(part).toMatch(/^[0-9a-f]{12}$/);
    }
  });
});

describe('buildTraceIdBlock', () => {
  it('默认模板:单行,trace_id=<id>,占位符已替换,含忽略指示', () => {
    const block = buildTraceIdBlock('abc123def456');
    expect(block).toBe(DEFAULT_TRACE_ID_TEMPLATE.replace('{traceId}', 'abc123def456'));
    expect(block).toContain('trace_id=abc123def456');
    expect(block).not.toContain('{traceId}');
    expect(block.split('\n')).toHaveLength(1);
  });

  it('自定义模板:{traceId} 占位符替换', () => {
    expect(buildTraceIdBlock('abc123def456', '追踪: {traceId} / end')).toBe(
      '追踪: abc123def456 / end',
    );
  });

  it('模板缺 {traceId} 占位符 → 抛 AgentError（fail fast,不静默渲染坏块）', () => {
    expect(() => buildTraceIdBlock('abc123def456', 'no placeholder here')).toThrow(AgentError);
    expect(() => buildTraceIdBlock('abc123def456', '')).toThrow(AgentError);
  });
});
