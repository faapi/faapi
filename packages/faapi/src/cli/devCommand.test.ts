import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * devCommand 测试：验证 dev 模式编排顺序和参数传递
 *
 * devCommand 是 dev 模式编排核心，调用多个依赖（compileConfig、loadConfig、
 * scanRoutes、scanTools、scanAgents、createDevApp、startWatcher）。
 * 测试策略：vi.mock 替换全部依赖为 spy，验证：
 * - 编排顺序正确（loadEnv → setDevOnDemandEnabled → compileConfig → generateRouteArtifacts
 *   → generateToolArtifacts → generateAgentArtifacts → createDevApp.listen → startWatcher）
 * - NODE_ENV 兜底（未设置时设为 development）
 * - FAAPI_DIST 固定为 .faapi
 * - port 选项透传给 createDevApp
 * - 内部辅助函数 generateRouteArtifacts/generateToolArtifactsForDev/generateAgentArtifactsForDev
 *   生成正确产物
 *
 * 不测试依赖模块自身行为（它们已有独立测试），只验证编排逻辑。
 */

// mock 全部依赖
vi.mock('./compileConfig', () => ({
  compileConfig: vi.fn(async () => ({ generated: false, outputFile: '' })),
}));
vi.mock('../config/loadConfig', () => ({
  loadConfig: vi.fn(async () => ({})),
}));
vi.mock('./loadEnv', () => ({
  loadEnv: vi.fn(),
}));
vi.mock('./watcher', () => ({
  startWatcher: vi.fn(),
}));
vi.mock('./createDevApp', () => ({
  createDevApp: vi.fn(async () => ({
    listen: vi.fn(async () => {}),
  })),
}));
vi.mock('./compileOnDemand', () => ({
  setDevOnDemandEnabled: vi.fn(),
  setDevDist: vi.fn(),
}));
// mock generateRouteArtifacts 的依赖（scanRoutes/serializeRoutes/writeRoutesModule）
vi.mock('../router/scanRoutes', () => ({
  scanRoutes: vi.fn(async () => ({ routes: [], wsRoutes: [] })),
}));
vi.mock('../router/sortRoutes', () => ({
  sortRoutes: vi.fn((routes) => routes),
}));
vi.mock('./generateRoutes', () => ({
  serializeRoutes: vi.fn(() => ''),
  writeRoutesModule: vi.fn(async () => {}),
}));
// mock generateToolArtifactsForDev 的依赖
vi.mock('../tools/scanTools', () => ({
  scanTools: vi.fn(async () => []),
  TOOL_PATTERNS: ['src/tools/**/*.ts'],
}));
vi.mock('./generateToolArtifacts', () => ({
  generateToolArtifacts: vi.fn(async () => {}),
}));
// mock generateAgentArtifactsForDev 的依赖
vi.mock('../agents/scanAgents', () => ({
  scanAgents: vi.fn(async () => []),
  DEFAULT_AGENT_PATTERNS: ['src/agents/**/*.ts'],
}));
vi.mock('./generateAgentArtifacts', () => ({
  generateAgentArtifacts: vi.fn(async () => {}),
}));

const {
  devCommand,
  generateRouteArtifacts,
  generateToolArtifactsForDev,
  generateAgentArtifactsForDev,
} = await import('./devCommand');
const { compileConfig } = await import('./compileConfig');
const { loadConfig } = await import('../config/loadConfig');
const { loadEnv } = await import('./loadEnv');
const { startWatcher } = await import('./watcher');
const { createDevApp } = await import('./createDevApp');
const { setDevOnDemandEnabled, setDevDist } = await import('./compileOnDemand');
const { scanRoutes } = await import('../router/scanRoutes');
const { sortRoutes } = await import('../router/sortRoutes');
const { serializeRoutes, writeRoutesModule } = await import('./generateRoutes');
const { scanTools } = await import('../tools/scanTools');
const { generateToolArtifacts } = await import('./generateToolArtifacts');
const { scanAgents } = await import('../agents/scanAgents');
const { generateAgentArtifacts } = await import('./generateAgentArtifacts');

describe('devCommand', () => {
  const originalCwd = process.cwd;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalFaapiDist = process.env.FAAPI_DIST;

  beforeEach(() => {
    // mock process.cwd 返回固定路径
    process.cwd = () => '/fake/project';
    // 清理环境变量
    delete process.env.NODE_ENV;
    delete process.env.FAAPI_DIST;
    // 清理所有 spy 调用记录
    vi.mocked(compileConfig).mockClear();
    vi.mocked(loadConfig).mockClear();
    vi.mocked(loadEnv).mockClear();
    vi.mocked(startWatcher).mockClear();
    vi.mocked(createDevApp).mockClear();
    vi.mocked(setDevOnDemandEnabled).mockClear();
    vi.mocked(setDevDist).mockClear();
    vi.mocked(scanRoutes).mockClear();
    vi.mocked(sortRoutes).mockClear();
    vi.mocked(serializeRoutes).mockClear();
    vi.mocked(writeRoutesModule).mockClear();
    vi.mocked(scanTools).mockClear();
    vi.mocked(generateToolArtifacts).mockClear();
    vi.mocked(scanAgents).mockClear();
    vi.mocked(generateAgentArtifacts).mockClear();
    // mock createDevApp 返回带 listen spy 的 app
    vi.mocked(createDevApp).mockResolvedValue({
      listen: vi.fn(async () => {}),
    } as any);
    // 抑制 console.log
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    process.cwd = originalCwd;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalFaapiDist === undefined) delete process.env.FAAPI_DIST;
    else process.env.FAAPI_DIST = originalFaapiDist;
    vi.restoreAllMocks();
  });

  describe('环境准备', () => {
    it('NODE_ENV 未设置时兜底为 development', async () => {
      await devCommand();
      expect(process.env.NODE_ENV).toBe('development');
    });

    it('NODE_ENV 已设置时不覆盖', async () => {
      process.env.NODE_ENV = 'staging';
      await devCommand();
      expect(process.env.NODE_ENV).toBe('staging');
    });

    it('FAAPI_DIST 固定为 .faapi', async () => {
      await devCommand();
      expect(process.env.FAAPI_DIST).toBe('.faapi');
    });

    it('启用按需编译模式（setDevOnDemandEnabled + setDevDist）', async () => {
      await devCommand();
      expect(setDevOnDemandEnabled).toHaveBeenCalledWith(true);
      expect(setDevDist).toHaveBeenCalledWith('.faapi');
    });

    it('loadEnv 传入 rootDir', async () => {
      await devCommand();
      expect(loadEnv).toHaveBeenCalledWith('/fake/project');
    });
  });

  describe('编排顺序', () => {
    it('compileConfig 在 loadConfig 之前调用', async () => {
      const calls: string[] = [];
      vi.mocked(compileConfig).mockImplementation(async () => {
        calls.push('compileConfig');
        return { generated: false, outputFile: '' };
      });
      vi.mocked(loadConfig).mockImplementation(async () => {
        calls.push('loadConfig');
        return {};
      });
      await devCommand();
      expect(calls.indexOf('compileConfig')).toBeLessThan(calls.indexOf('loadConfig'));
    });

    it('compileConfig 传入 rootDir 和 dist=.faapi', async () => {
      await devCommand();
      expect(compileConfig).toHaveBeenCalledWith({
        rootDir: '/fake/project',
        dist: '.faapi',
      });
    });

    it('createDevApp 传入 rootDir 和 port', async () => {
      await devCommand({ port: 4000 });
      expect(createDevApp).toHaveBeenCalledWith({
        rootDir: '/fake/project',
        port: 4000,
      });
    });

    it('createDevApp 默认无 port', async () => {
      await devCommand();
      expect(createDevApp).toHaveBeenCalledWith({
        rootDir: '/fake/project',
        port: undefined,
      });
    });

    it('app.listen() 被调用', async () => {
      const listenSpy = vi.fn(async () => {});
      vi.mocked(createDevApp).mockResolvedValue({
        listen: listenSpy,
      } as any);
      await devCommand();
      expect(listenSpy).toHaveBeenCalledTimes(1);
    });

    it('startWatcher 传入 rootDir、app、devDist', async () => {
      const fakeApp = { listen: vi.fn(async () => {}) };
      vi.mocked(createDevApp).mockResolvedValue(fakeApp as any);
      await devCommand();
      expect(startWatcher).toHaveBeenCalledWith({
        rootDir: '/fake/project',
        app: fakeApp,
        devDist: '.faapi',
      });
    });
  });

  describe('generateRouteArtifacts', () => {
    it('scanRoutes 传入 rootDir、PATTERNS、dist', async () => {
      await generateRouteArtifacts('/root', ['src/api/**/*.ts'], '.faapi');
      expect(scanRoutes).toHaveBeenCalledWith('/root', ['src/api/**/*.ts'], '.faapi');
    });

    it('sortRoutes 对 scanRoutes 返回的 routes 排序', async () => {
      const fakeRoutes = [{ path: '/b' }, { path: '/a' }] as any;
      vi.mocked(scanRoutes).mockResolvedValue({ routes: fakeRoutes, wsRoutes: [] });
      await generateRouteArtifacts('/root', [], '.faapi');
      expect(sortRoutes).toHaveBeenCalledWith(fakeRoutes);
    });

    it('serializeRoutes 传入 sorted、wsRoutes、rootDir、dist', async () => {
      const fakeRoutes = [{ path: '/a' }] as any;
      const fakeWsRoutes = [{ path: '/ws' }] as any;
      vi.mocked(scanRoutes).mockResolvedValue({ routes: fakeRoutes, wsRoutes: fakeWsRoutes });
      vi.mocked(sortRoutes).mockReturnValue(fakeRoutes);
      await generateRouteArtifacts('/root', [], 'dist');
      expect(serializeRoutes).toHaveBeenCalledWith(fakeRoutes, fakeWsRoutes, '/root', 'dist');
    });

    it('writeRoutesModule 写入 <rootDir>/<dist>/faapi-routes.js', async () => {
      await generateRouteArtifacts('/root', [], 'dist');
      expect(writeRoutesModule).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringMatching(/\/root\/dist\/faapi-routes\.js$/),
      );
    });
  });

  describe('generateToolArtifactsForDev', () => {
    it('scanTools 传入 rootDir、TOOL_PATTERNS', async () => {
      await generateToolArtifactsForDev('/root', '.faapi');
      expect(scanTools).toHaveBeenCalledWith('/root', ['src/tools/**/*.ts']);
    });

    it('generateToolArtifacts 传入 skipSchema: true（dev 按需模式跳过 zod.js）', async () => {
      const fakeTools = [{ name: 'tool1' }] as any;
      vi.mocked(scanTools).mockResolvedValue(fakeTools);
      await generateToolArtifactsForDev('/root', '.faapi');
      expect(generateToolArtifacts).toHaveBeenCalledWith(fakeTools, '/root', '.faapi', {
        skipSchema: true,
      });
    });
  });

  describe('generateAgentArtifactsForDev', () => {
    it('scanAgents 传入 rootDir、DEFAULT_AGENT_PATTERNS', async () => {
      await generateAgentArtifactsForDev('/root', '.faapi');
      expect(scanAgents).toHaveBeenCalledWith('/root', ['src/agents/**/*.ts']);
    });

    it('generateAgentArtifacts 传入 scanAgents 返回值', async () => {
      const fakeAgents = [{ name: 'agent1' }] as any;
      vi.mocked(scanAgents).mockResolvedValue(fakeAgents);
      await generateAgentArtifactsForDev('/root', '.faapi');
      expect(generateAgentArtifacts).toHaveBeenCalledWith(fakeAgents, '/root', '.faapi');
    });
  });
});
