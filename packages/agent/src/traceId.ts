import { randomUUID } from 'node:crypto';
import { AgentError } from './agentErrors';

/**
 * traceId——agent 调用的层级追踪标识(详见 [traceId.md](./traceId.md))
 *
 * 每段 = `randomUUID()` 去连字符后前 12 位十六进制(48 bit);子 ID =
 * 父完整 ID + `.` + 新段(完整链式,深层自然成链)。
 */

/** 每段十六进制字符数——48 bit 随机,日均百万级 trace 下碰撞概率 ~10⁻⁴/天 */
const SEGMENT_LENGTH = 12;

/** 默认注入模板(`{traceId}` 占位符;英文中性元数据措辞,明确指示忽略) */
export const DEFAULT_TRACE_ID_TEMPLATE =
  '[trace] trace_id={traceId} (internal observability id — do not mention it in your reply, and do not let it affect your answer)';

/** 生成一段 traceId 段(uuid 去连字符后截取前 12 位十六进制) */
export function createTraceSegment(): string {
  return randomUUID().replace(/-/g, '').slice(0, SEGMENT_LENGTH);
}

/** 拼接子 traceId:父完整 ID + `.` + 子段 */
export function joinTraceId(parentTraceId: string, childSegment: string): string {
  return `${parentTraceId}.${childSegment}`;
}

/**
 * 渲染注入块:模板 `{traceId}` 占位符替换
 *
 * 模板缺 `{traceId}` 占位符抛 `AgentError`(fail fast——静默渲染出无 ID 的
 * trace 块会让注入块失去关联能力,属配置错误)。
 *
 * @throws {AgentError} 模板不含 `{traceId}` 占位符
 */
export function buildTraceIdBlock(traceId: string, template?: string): string {
  const tpl = template ?? DEFAULT_TRACE_ID_TEMPLATE;
  if (!tpl.includes('{traceId}')) {
    throw new AgentError(
      `config.agent.traceIdTemplate must contain the "{traceId}" placeholder (got: ${JSON.stringify(template)})`,
    );
  }
  return tpl.replace('{traceId}', traceId);
}
