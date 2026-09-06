import { scanRoutes } from '../router/scanRoutes';
import { sortRoutes } from '../router/sortRoutes';
import { detectRouteConflicts } from '../router/detectRouteConflicts';
import { scanTools } from '../tools/scanTools';
import { TOOL_PATTERNS } from '../tools/scanTools';
import { generateToolArtifacts } from './generateToolArtifacts';
import { scanAgents } from '../agents/scanAgents';
import { DEFAULT_AGENT_PATTERNS } from '../agents/scanAgents';
import { generateAgentArtifacts } from './generateAgentArtifacts';
import { generateSchemaFiles } from './generateSchemaFiles';
import { serializeRoutes, writeRoutesModule } from './generateRoutes';
import { compileBuildRoutes } from './compileBuildRoutes';
import { ROUTE_PATTERNS } from '../utils/prodPaths';
import { compileConfig, compileProjectModules } from './compileConfig';
import { loadConfig } from '../config/loadConfig';
import { resolveLocalPluginSource } from './loadPlugins';
import type { PluginDeclaration } from '../config/pluginTypes';
import path from 'node:path';
import fs from 'node:fs';
import { isInsideDir, toRealPath } from '../utils/prodPaths';

/** build 模式默认产物目录 */
const DEFAULT_DIST = 'dist';
/** 路由源码目录（写死为 src，路由 .ts 文件位于 src/api/ 下） */

/**
 * 构建命令选项
 */
export interface BuildOptions {
  /** 项目根目录，默认 process.cwd() */
  rootDir?: string;
  /** 产物输出目录，默认 dist */
  dist?: string;
}

/**
 * 执行构建命令
 *
 * `--dist` 直接作为产物输出目录（默认 `dist`），与 Next.js `distDir` 语义一致。
 * 运行时只加载 .js 产物，不依赖 tsx。
 *
 * 应用行为配置从 faapi.config.ts 读取。
 *
 * 框架采用零入口设计——用户无需编写 main.ts，build 阶段自动生成 `<dist>/main.js` 启动入口，
 * 运行时 `node <dist>/main` 直接启动服务，无需 `faapi start` 命令。
 *
 * 端口不通过 build 选项指定——`main.js` 中 `listen()` 无参，运行时由 `PORT` 环境变量
 * 或默认值 3000 决定（与 `next build` 不支持 `--port` 的设计一致）。
 *
 * 流程：
 * 0. 编译配置产物（compileConfig）→ loadConfig 读应用行为配置
 * 1. 编译 TypeScript（逐文件编译，与 dev 一致，打平 src/ 前缀）
 * 2. 重新编译配置文件（确保使用最新源码）
 * 3. 扫描路由（从 <dist> 产物，import .js 拿方法名）
 * 4. 生成 schema 模块（AST 从源码 .ts）
 * 5. 生成路由清单
 * 6. 生成启动入口 <dist>/main.js（import createProdApp + loadEnv + listen）
 *
 * **统一编译模式**：build 与 dev 都采用 `bundle: false` 逐文件编译，差异仅由 `dist` 驱动，
 * 不存在 `if (isDev)` 控制流分支。逐文件编译保证每个源文件对应唯一一份产物，
 * config 和 routes 共享同一运行时对象（`instanceof` 跨边界生效）。
 */
export async function buildCommand(options?: BuildOptions): Promise<void> {
  const rootDir = options?.rootDir ?? process.cwd();
  const outdir = options?.dist ?? DEFAULT_DIST;

  // 清空输出目录（Vite emptyOutDir 语义）：删除路由后 dist 残留旧 handler.js /
  // zod.js / map 文件，体积膨胀且误导排查。防误删保护：outdir 必须严格位于
  // rootDir 内（两侧 realpath 归一化，tmpdir 符号链接不误判）且不等于 rootDir
  const absOut = path.resolve(rootDir, outdir);
  const realRoot = toRealPath(path.resolve(rootDir));
  if (isInsideDir(toRealPath(absOut), realRoot)) {
    fs.rmSync(absOut, { recursive: true, force: true });
  } else {
    console.warn(
      `! Output directory "${outdir}" is outside the project root, skipping clean (stale artifacts may remain)`,
    );
  }

  // 加载 config
  // build 时无产物，先 compileConfig 生成临时产物到 outdir，再用 loadConfig 读
  await compileConfig({ rootDir, dist: outdir });
  const _config = await loadConfig(rootDir, outdir);

  // CJS 项目告警：产物为 ESM（main.js 用 import 语句），缺 type:module 时
  // node dist/main 报 "Cannot use import statement outside a module"，用户无法关联原因
  const pkgPath = path.resolve(rootDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { type?: string };
      if (pkg.type !== 'module') {
        console.warn(
          '! package.json is missing "type": "module" — build output is ESM and `node dist/main` will fail without it',
        );
      }
    } catch {
      // package.json 解析失败不阻断构建
    }
  }

  console.log('faapi build started');
  console.log(`- Root: ${rootDir}`);
  console.log(`- Source: src/`);
  console.log(`- Output: ${outdir}`);

  // 1. 编译 TypeScript（逐文件编译，与 dev 一致）
  console.log('\n[1/8] Compiling TypeScript (bundle: false)...');
  const result = await compileBuildRoutes({
    rootDir,
    dist: outdir,
    logLevel: 'silent',
  });
  console.log(`  Compiled ${result.compiledFiles.length} file(s)`);
  if (result.compiledFiles.length === 0) {
    console.warn('  ! No source files found, nothing to build');
    return;
  }

  // 2. 配置产物已在步骤 0 编译（compileConfig 内部有 mtime 缓存，无源码变化
  //    时重复调用只会命中缓存——此前重复调用还打印 "Written to" 撒谎日志）

  // 2.5 编译本地 TS 插件（config.plugins 的 path 声明）：源文件 + src 外依赖闭包
  //     编译到 `<dist>/` 下（保留相对结构），运行时 loadPlugins 直接 import 产物。
  //     插件引用的 src 内模块已由步骤 1 全量编译，无需重复。
  const localPluginSources = extractLocalPluginSources(_config?.plugins, rootDir);
  if (localPluginSources.length > 0) {
    console.log('\n[2.5/8] Compiling local plugins...');
    const outside = localPluginSources.filter((p) => {
      const rel = path.relative(rootDir, p).replace(/\\/g, '/');
      return !rel.startsWith('src/');
    });
    if (outside.length > 0) {
      await compileProjectModules(outside, rootDir, outdir);
    }
    console.log(`  Compiled ${localPluginSources.length} local plugin(s)`);
  }

  // 3. 扫描路由（扫描源码 .ts 文件列表，但 import 产物 .js 拿方法名）
  console.log('\n[3/8] Scanning routes...');
  const { routes, wsRoutes } = await scanRoutes(rootDir, ROUTE_PATTERNS, outdir);
  const sorted = sortRoutes(routes);
  console.log(`  Found ${sorted.length} routes, ${wsRoutes.length} WS routes`);

  // 检测路由冲突
  const conflicts = detectRouteConflicts(sorted);
  if (conflicts.length > 0) {
    console.warn('! 检测到路由冲突：');
    for (const conflict of conflicts) {
      console.warn(`  ${conflict.method} ${conflict.urlPath}`);
      for (const file of conflict.files) {
        console.warn(`    - ${file}`);
      }
    }
  }

  // 4. 生成 schema 文件
  console.log('\n[4/8] Generating schema...');
  await generateSchemaFiles(sorted, rootDir, outdir);
  console.log(`  Schema: zod.js files under ${path.resolve(rootDir, outdir)}`);

  // 5. 生成路由清单（prd 启动时直接读取，不再 scanRoutes）
  console.log('\n[5/8] Generating routes manifest...');
  const routesPath = path.resolve(rootDir, outdir, 'faapi-routes.js');
  const serialized = serializeRoutes(sorted, wsRoutes, rootDir, outdir);
  await writeRoutesModule(serialized, routesPath);
  console.log(`  Written to ${routesPath}`);

  // 6. 生成 tool 清单 + schema（scanTools 读源码 + 正则提取函数名，generateToolArtifacts 做 AST 增强）
  //    与路由对称——生成 faapi-tools.js（tool 清单）+ 每个 tool handler 的 zod.js
  //    无 tool 文件时 scanTools 返回空列表，generateToolArtifacts 写入空清单
  console.log('\n[6/8] Generating tool manifest and schema...');
  const tools = await scanTools(rootDir, TOOL_PATTERNS);
  const toolMeta = await generateToolArtifacts(tools, rootDir, outdir);
  console.log(`  Found ${toolMeta.length} tool(s)`);
  console.log(`  Tool manifest: ${path.resolve(rootDir, outdir, 'faapi-tools.js')}`);

  // 7. 生成 agent 清单（scanAgents 读源码 + 正则检测 config/run，generateAgentArtifacts 做 AST 增强）
  //    agent 不生成 zod.js（无输入参数，config 块字段在 AST 阶段已提取为字面量）
  //    无 agent 文件时 scanAgents 返回空列表，generateAgentArtifacts 写入空清单
  console.log('\n[7/8] Generating agent manifest...');
  const agents = await scanAgents(rootDir, DEFAULT_AGENT_PATTERNS);
  const agentMeta = await generateAgentArtifacts(agents, rootDir, outdir);
  console.log(`  Found ${agentMeta.length} agent(s)`);
  console.log(`  Agent manifest: ${path.resolve(rootDir, outdir, 'faapi-agents.js')}`);

  // 8. 生成启动入口 main.js（零入口设计：用户无需编写 main.ts）
  //    内部 import @faapi/faapi 的 createProdApp + loadEnv + listen
  //    运行时 `node <dist>/main` 直接启动：loadEnv 加载 .env → createProdApp 水合产物 → listen
  //    --dist 选项写入 main.js（非默认 dist 时），端口由运行时 PORT 环境变量决定
  console.log('\n[8/8] Generating entry file...');
  const mainPath = path.resolve(rootDir, outdir, 'main.js');
  // 非默认 dist 时写入 createProdApp 参数，让 prod 启动时能定位到产物目录
  // JSON.stringify 生成合法 JS 字符串字面量：Windows 反斜杠路径（.\build 的 \b 是退格转义）
  // 与含引号路径不再损坏
  const createProdAppArgs =
    options?.dist && options.dist !== DEFAULT_DIST ? `{ dist: ${JSON.stringify(outdir)} }` : '';
  const mainContent = `// 由 faapi build 自动生成，请勿手动编辑
import { createProdApp, loadEnv } from '@faapi/faapi';

// 兜底 NODE_ENV（未显式设置时）+ 加载 .env 系列文件到 process.env
if (!process.env.NODE_ENV) process.env.NODE_ENV = 'production';
loadEnv(process.cwd());

const app = await createProdApp(${createProdAppArgs});
await app.listen();
`;
  await fs.promises.writeFile(mainPath, mainContent, 'utf-8');
  console.log(`  Written to ${mainPath}`);

  console.log('\nfaapi build completed');
}

/**
 * 从 plugins 声明提取本地 TS/JS 插件源文件（build 端编译入口）
 *
 * 只取相对/绝对路径声明（`./x`、`../x`、绝对路径）；包名声明跳过（运行时 Node 解析）。
 * 探测不到源文件的声明跳过——运行时 loadPlugins 会报带修复指引的失败，build 不在此
 * 替代报错（文件可能在运行时才出现，或用户笔误由运行时日志定位）。
 */
function extractLocalPluginSources(
  declarations: PluginDeclaration[] | undefined,
  rootDir: string,
): string[] {
  if (!declarations || declarations.length === 0) return [];
  const sources: string[] = [];
  const seen = new Set<string>();
  for (const decl of declarations) {
    let specifier: string | undefined;
    if (typeof decl === 'string') specifier = decl;
    else if (Array.isArray(decl)) specifier = decl[0];
    else if ('path' in decl) specifier = decl.path;
    if (!specifier) continue;
    if (
      !specifier.startsWith('./') &&
      !specifier.startsWith('../') &&
      !path.isAbsolute(specifier)
    ) {
      continue; // 包名声明
    }
    const source = resolveLocalPluginSource(specifier, rootDir);
    if (source && !seen.has(source)) {
      seen.add(source);
      sources.push(source);
    }
  }
  return sources;
}
