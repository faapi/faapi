/**
 * Calculator tool — 简单计算
 *
 * 共享 tool，支持加减乘除四则运算。
 */

export interface CalcInput {
  /** 表达式，如 "1+2" */
  expression: string;
}

/**
 * 计算表达式
 */
export async function calc(input: CalcInput) {
  const match = input.expression.match(/^(\d+)\s*([+\-*/])\s*(\d+)$/);
  if (!match) {
    return { error: 'unsupported expression', expression: input.expression };
  }
  const a = Number(match[1]);
  const b = Number(match[3]);
  const op = match[2]!;
  let result: number;
  switch (op) {
    case '+':
      result = a + b;
      break;
    case '-':
      result = a - b;
      break;
    case '*':
      result = a * b;
      break;
    case '/':
      result = b === 0 ? Number.NaN : a / b;
      break;
    default:
      return { error: 'unknown operator', op };
  }
  return { expression: input.expression, result };
}
