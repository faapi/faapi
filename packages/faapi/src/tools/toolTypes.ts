/**
 * Tool 清单记录
 *
 * 由 scanTools 扫描文件系统生成，描述一个 tool 的元信息。
 * 与 RouteRecord 对称——一个文件可声明多个 tool（一个函数 = 一个 manifest 项）。
 *
 * tool 名格式：子目录.函数名（如 weather.getWeather），无子目录时纯函数名。
 * 所有 tool 都是共享的——agent 通过 config 块的 `tools` 字段显式声明引用哪些。
 * functionName 单独保留供 AST 提取阶段在源文件中定位目标函数（@tool JSDoc 可覆盖 name，
 * 但 functionName 仍是源码中的真实导出名，用于 extractToolMetadata 查找函数节点）。
 */
export interface ToolManifest {
  /** tool 名，格式 子目录.函数名（如 weather.getWeather），无子目录则纯函数名 */
  name: string;
  /** 源码中的真实导出函数名（如 getWeather），供 extractToolMetadata 在源文件中查找函数节点 */
  functionName: string;
  /** 源码相对路径，如 src/tools/weather/handler.ts */
  filePath: string;
}

export type ToolManifestList = ToolManifest[];
