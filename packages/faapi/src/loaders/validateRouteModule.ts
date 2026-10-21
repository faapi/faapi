/**
 * 校验导出值是否为合法的 handler 函数
 */
export function validateRouteModule(
  value: unknown,
  method: string,
  filePath: string,
): asserts value is (...args: unknown[]) => unknown {
  if (typeof value !== 'function') {
    throw new Error(
      `Route module "${filePath}" does not export a valid handler for method "${method}". ` +
        `Expected a function, got ${typeof value}.`,
    );
  }
}
