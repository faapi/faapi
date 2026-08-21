import path from 'node:path';
import { compileConfig } from './compileConfig';
import { serializeRoutes, writeRoutesModule } from './generateRoutes';
import { scanRoutes } from '../router/scanRoutes';
import { sortRoutes } from '../router/sortRoutes';
import { scanTools } from '../tools/scanTools';
import { TOOL_PATTERNS } from '../tools/scanTools';
import { generateToolArtifacts } from './generateToolArtifacts';
import { scanAgents } from '../agents/scanAgents';
import { DEFAULT_AGENT_PATTERNS } from '../agents/scanAgents';
import { generateAgentArtifacts } from './generateAgentArtifacts';
import { loadConfig } from '../config/loadConfig';
import { loadEnv } from './loadEnv';
import { startWatcher } from './watcher';
import { createDevApp } from './createDevApp';
import { setDevOnDemandEnabled, setDevDist } from './compileOnDemand';

/** dev 模式产物目录（固定为 .faapi，不可修改） */
const DEV_DIST = '.faapi';
/** 路由清单文件名 */
const ROUTES_FILE = 'faapi-routes.js';
/** 路由源码目录（写死为 src，路由 .ts 文件位于 src/api/ 下） */
const PATTERNS = ['src/api/**/*.ts'];

/** dev 命令选项（来自 CLI 参数） */
export interface DevCommandOptions {
  port?: number;
}

/**
 * `faapi dev` 命令：编译配置 → 生成路由清单 → 启动 dev 应用 → 启动 watcher
 *
 * **Vite 风格按需编译**（阶段 2+3）：启动时只编译配置和路由清单，**不全量编译 handler.js / zod.js**。
 * - handler.js 在首次请求时由 `loadRouteModule` / `loadWsHandler` 触发按需编译
 * - zod.js 在首次请求时由 `ensureSchemaGenerated` 触发按需生成
 *
 * 与 `faapi build`（产线构建）为两套独立代码路径，仅共享工具级函数。
 *
 * 框架元信息通过 CLI 选项或环境变量传入（不放在 faapi.config.ts 内）：
 * - `--port` / `PORT`：服务端口，默认 3000
 * - `FAAPI_DIST`：dev 模式由 devCommand 固定设为 `.faapi`
 *
 * 产物（与 `faapi build` 一致，仅目录不同：dev 用 `.faapi/`，build 用 `dist/`）：
 * 1. `.faapi/faapi-config.js` — 配置合并产物（compileConfig 生成）
 * 2. `.faapi/faapi-routes.js` — 路由清单（serializeRoutes 生成）
 * 3. `.faapi/` 下各 handler 目录的 `zod.js` — schema 模块（**按需生成**，首次请求触发）
 * 4. `.faapi/` 下的 handler `*.js` — **按需编译**（首次请求时触发，非启动时全量）
 *
 * 流程：
 * 1. 兜底 NODE_ENV（未显式设置时）+ 加载 .env 系列文件到 process.env（loadEnv）
 * 2. 设置 dev 环境标记 + `FAAPI_DIST=.faapi` + 启用按需编译模式
 * 3. 编译配置产物（compileConfig）—— config 引用的项目模块也由 compileConfig 编译
 * 4. 生成路由清单（scanRoutes 读源码 + 正则提取方法名，零 import）
 * 5. 调用 createDevApp() + listen() 启动 dev 应用（含 reloadRoutes 热替换能力）
 * 6. 启动 watcher（增量编译 + 重生成 config + 调 app.reloadRoutes 热替换）
 *
 * **与旧版（启动全量编译）的差异**：
 * - 旧版：步骤 4 之前调 `compileDevRoutes` + `generateSchemaFiles` 全量编译所有 .ts 和生成 zod.js → 启动慢
 * - 新版：跳过全量编译和 schema 生成，handler.js / zod.js 按需生成 → 启动快，首请求有单文件编译延迟（~50ms）
 */
export async function devCommand(options?: DevCommandOptions): Promise<void> {
  const rootDir = process.cwd();

  // 1. 兜底 NODE_ENV（未显式设置时）+ 加载 .env 系列文件到 process.env
  //    loadEnv 读 NODE_ENV 决定加载 .env.{env}，需在 loadEnv 之前设置
  if (!process.env.NODE_ENV) process.env.NODE_ENV = 'development';
  loadEnv(rootDir);

  // 2. 设置 dist（固定为 .faapi，不可修改）+ 启用按需编译模式
  const devDist = DEV_DIST;
  process.env.FAAPI_DIST = devDist;
  setDevOnDemandEnabled(true);
  setDevDist(devDist);
  console.log('- Development mode (on-demand compile)');

  // 3. 编译配置产物（compileConfig 内部编译 config 源 + 引用的项目模块）
  console.log('- Compiling config...');
  await compileConfig({ rootDir, dist: devDist });
  const _config = await loadConfig(rootDir, devDist);

  // 4. 生成路由清单 + schema 文件（scanRoutes 不 import，仅读源码 + 正则提取方法名）
  console.log('- Generating route manifest and schema...');
  await generateRouteArtifacts(rootDir, PATTERNS, devDist);

  // 5. 生成 tool 清单（scanTools 不 import，仅读源码 + 正则提取函数名）
  //    按需模式跳过 zod.js 生成——首次请求时按需生成（与路由 schema 策略一致）
  console.log('- Generating tool manifest...');
  await generateToolArtifactsForDev(rootDir, devDist);

  // 6. 生成 agent 清单（scanAgents 不 import，仅读源码 + 正则检测 config/run）
  //    agent 不生成 zod.js（无输入参数），无 skipSchema 选项
  //    无 agent 文件时 scanAgents 返回空列表，generateAgentArtifacts 写入空清单
  console.log('- Generating agent manifest...');
  await generateAgentArtifactsForDev(rootDir, devDist);

  // 7. 启动 dev 应用（createDevApp + listen，含 reloadRoutes/reloadTools/reloadAgents 热替换能力）
  console.log('- Starting dev app...');
  const app = await createDevApp({ rootDir, port: options?.port });
  await app.listen();

  // 8. 启动 watcher（文件变化时增量编译 + 重生成 config + 调 app.reloadRoutes/reloadTools/reloadAgents）
  startWatcher({ rootDir, app, devDist });
}

/**
 * 生成路由产物：faapi-routes.js（仅路由清单，不含 zod.js）
 *
 * zod.js 按需生成：首次请求时由 `ensureSchemaGenerated` 触发（阶段 3）。
 * 与 `faapi build` 不同——build 阶段全量生成 zod.js，dev 阶段按需生成。
 */
export async function generateRouteArtifacts(
  rootDir: string,
  patterns: string[],
  dist: string,
): Promise<void> {
  // 扫描路由（读源码 + 正则提取方法名，零 import）
  const { routes, wsRoutes } = await scanRoutes(rootDir, patterns, dist);
  const sorted = sortRoutes(routes);

  // 生成路由清单（zod.js 按需生成，不在启动时全量生成）
  const routesPath = path.resolve(rootDir, dist, ROUTES_FILE);
  const serialized = serializeRoutes(sorted, wsRoutes, rootDir, dist);
  await writeRoutesModule(serialized, routesPath);
}

/**
 * 生成 tool 产物：faapi-tools.js（仅 tool 清单，不含 zod.js）
 *
 * 与 `generateRouteArtifacts` 对称——dev 按需模式跳过 zod.js 生成，
 * 首次请求时按需生成（tool zod.js 的按需生成由 toolRegistry 在 Phase 1.6+ 接入）。
 * 无 tool 文件时 scanTools 返回空列表，generateToolArtifacts 写入空清单。
 */
export async function generateToolArtifactsForDev(rootDir: string, dist: string): Promise<void> {
  const tools = await scanTools(rootDir, TOOL_PATTERNS);
  await generateToolArtifacts(tools, rootDir, dist, { skipSchema: true });
}

/**
 * 生成 agent 产物：faapi-agents.js（仅 agent 清单，不含 zod.js）
 *
 * 与 `generateToolArtifactsForDev` 对称——agent 不生成 zod.js（无输入参数，
 * config 块字段在 AST 阶段已提取为字面量）。无 agent 文件时 scanAgents 返回空列表，
 * generateAgentArtifacts 写入空清单。
 */
export async function generateAgentArtifactsForDev(rootDir: string, dist: string): Promise<void> {
  const agents = await scanAgents(rootDir, DEFAULT_AGENT_PATTERNS);
  await generateAgentArtifacts(agents, rootDir, dist);
}
