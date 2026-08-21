/**
 * Weather tool — 查询天气
 *
 * 共享 tool（src/tools/ 下，所有 agent 可用）。
 * 导出 getWeather 函数，第一个参数 interface 声明 input 类型（AST 提取生成 zod schema）。
 */

export interface WeatherInput {
  /** 城市名 */
  city: string;
}

/**
 * 查询城市天气
 */
export async function getWeather(input: WeatherInput) {
  // demo 简化：返回固定数据
  const temps: Record<string, number> = {
    北京: 22,
    上海: 25,
    广州: 30,
  };
  const temp = temps[input.city] ?? 20;
  return { city: input.city, temperature: temp, condition: '晴' };
}
