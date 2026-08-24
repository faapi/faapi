/**
 * formatErrorResponse 的 re-export
 *
 * 实现已移至 [response/responseFormatter.ts](../response/responseFormatter.ts),
 * 与 wrapOkResult / formatFailResponse 共享同一套 ok/fail 函数,确保错误响应格式
 * 在「handler 抛错兜底」和「handler return ctx.fail()」两条路径一致。
 *
 * 保留此文件作为 errors/ 模块的入口,便于 errors 模块内部互引 +
 * 不破坏现有 import 路径(formatErrorResponse.test.ts / serverUtils.ts 等)。
 */
export { formatErrorResponse } from '../response/responseFormatter';
