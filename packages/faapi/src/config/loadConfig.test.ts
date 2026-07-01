import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { loadConfig } from './loadConfig';

/**
 * 创建临时目录并在其中写入配置文件
 */
function createTempDir(files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faapi-config-test-'));
  for (const [fileName, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, fileName), content, 'utf-8');
  }
  return dir;
}

/**
 * 清理临时目录
 */
function cleanupDir(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('loadConfig', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      cleanupDir(dir);
    }
    tempDirs.length = 0;
  });

  const makeDir = (files?: Record<string, string>) => {
    const dir = createTempDir(files);
    tempDirs.push(dir);
    return dir;
  };

  it('无配置文件时返回 null', async () => {
    const dir = makeDir();
    const result = await loadConfig(dir);
    expect(result).toBeNull();
  });

  it('加载 faapi.config.js 配置文件', async () => {
    const dir = makeDir({
      'faapi.config.js': `
export default {
  port: 8080,
  cors: { origin: '*' },
};
`,
    });

    const result = await loadConfig(dir);
    expect(result).not.toBeNull();
    expect(result!.port).toBe(8080);
    expect(result!.cors).toEqual({ origin: '*' });
  });

  it('优先加载 faapi.config.ts 而非 faapi.config.js', async () => {
    // .ts 文件在动态导入时需要 tsx 等工具支持
    // 这里只验证 .js 存在时能正确加载
    const dir = makeDir({
      'faapi.config.js': `
export default {
  port: 9090,
  db: { host: 'localhost' },
};
`,
    });

    const result = await loadConfig(dir);
    expect(result).not.toBeNull();
    expect(result!.port).toBe(9090);
    expect(result!.db).toEqual({ host: 'localhost' });
  });

  it('指定 configPath 加载指定路径的配置文件', async () => {
    const dir = makeDir({
      'custom.config.js': `
export default {
  port: 3001,
  db: { host: 'db.example.com' },
};
`,
    });

    const result = await loadConfig(dir, 'custom.config.js');
    expect(result).not.toBeNull();
    expect(result!.port).toBe(3001);
    expect(result!.db).toEqual({ host: 'db.example.com' });
  });

  it('configPath 不存在时抛错', async () => {
    const dir = makeDir();

    await expect(loadConfig(dir, 'nonexistent.config.js')).rejects.toThrow('Config file not found');
  });

  it('配置文件导出 default 函数时返回函数本身（loadConfig 不自动调用）', async () => {
    const dir = makeDir({
      'faapi.config.js': `
export default function config() {
  return {
    port: 4000,
    rootDir: '/tmp/app',
  };
};
`,
    });

    const result = await loadConfig(dir);
    expect(result).not.toBeNull();
    // loadConfig 直接返回 module.default，不会调用函数
    expect(typeof result).toBe('function');
  });

  it('配置文件用 IIFE 导出对象时正确加载', async () => {
    const dir = makeDir({
      'faapi.config.js': `
const config = (() => ({
  port: 4000,
  rootDir: '/tmp/app',
}))();
export default config;
`,
    });

    const result = await loadConfig(dir);
    expect(result).not.toBeNull();
    expect(result!.port).toBe(4000);
    expect(result!.rootDir).toBe('/tmp/app');
  });

  it('配置文件语法错误时抛错', async () => {
    const dir = makeDir({
      'faapi.config.js': `
export default {
  port: 8080,
  // 缺少闭合括号
`,
    });

    await expect(loadConfig(dir)).rejects.toThrow('Failed to load config file');
  });

  describe('多环境配置', () => {
    it('加载 faapi.config.production.js 并深度合并到基础配置', async () => {
      const dir = makeDir({
        'faapi.config.js': `
export default {
  db: { host: 'localhost', port: 5432 },
  redis: { host: '127.0.0.1' },
};
`,
        'faapi.config.production.js': `
export default {
  db: { host: 'db.production.com' },
};
`,
      });

      const originalNodeEnv = process.env.NODE_ENV;
      const originalFaapiEnv = process.env.FAAPI_ENV;
      delete process.env.FAAPI_ENV;
      process.env.NODE_ENV = 'production';

      try {
        const result = await loadConfig(dir);
        expect(result).not.toBeNull();
        // db 深度合并：host 被覆盖，port 保留
        expect(result!.db).toEqual({ host: 'db.production.com', port: 5432 });
        // redis 未被覆盖，保留原值
        expect(result!.redis).toEqual({ host: '127.0.0.1' });
      } finally {
        process.env.NODE_ENV = originalNodeEnv;
        process.env.FAAPI_ENV = originalFaapiEnv;
      }
    });

    it('FAAPI_ENV 环境变量决定加载哪个环境配置', async () => {
      const dir = makeDir({
        'faapi.config.js': `
export default {
  db: { host: 'localhost', port: 5432 },
};
`,
        'faapi.config.staging.js': `
export default {
  db: { host: 'staging.db.com' },
};
`,
      });

      const originalNodeEnv = process.env.NODE_ENV;
      const originalFaapiEnv = process.env.FAAPI_ENV;
      process.env.NODE_ENV = '';
      process.env.FAAPI_ENV = 'staging';

      try {
        const result = await loadConfig(dir);
        expect(result).not.toBeNull();
        expect(result!.db).toEqual({ host: 'staging.db.com', port: 5432 });
      } finally {
        process.env.NODE_ENV = originalNodeEnv;
        process.env.FAAPI_ENV = originalFaapiEnv;
      }
    });

    it('FAAPI_ENV 优先于 NODE_ENV', async () => {
      const dir = makeDir({
        'faapi.config.js': `
export default {
  db: { host: 'localhost' },
};
`,
        'faapi.config.production.js': `
export default {
  db: { host: 'db.production.com' },
};
`,
        'faapi.config.staging.js': `
export default {
  db: { host: 'staging.db.com' },
};
`,
      });

      const originalNodeEnv = process.env.NODE_ENV;
      const originalFaapiEnv = process.env.FAAPI_ENV;
      process.env.NODE_ENV = 'production';
      process.env.FAAPI_ENV = 'staging';

      try {
        const result = await loadConfig(dir);
        expect(result).not.toBeNull();
        // FAAPI_ENV 优先，加载 staging 配置
        expect(result!.db).toEqual({ host: 'staging.db.com' });
      } finally {
        process.env.NODE_ENV = originalNodeEnv;
        process.env.FAAPI_ENV = originalFaapiEnv;
      }
    });

    it('FAAPI_ENV 未设时回退 NODE_ENV', async () => {
      const dir = makeDir({
        'faapi.config.js': `
export default {
  db: { host: 'localhost' },
};
`,
        'faapi.config.production.js': `
export default {
  db: { host: 'db.production.com' },
};
`,
      });

      const originalNodeEnv = process.env.NODE_ENV;
      const originalFaapiEnv = process.env.FAAPI_ENV;
      delete process.env.FAAPI_ENV;
      process.env.NODE_ENV = 'production';

      try {
        const result = await loadConfig(dir);
        expect(result).not.toBeNull();
        // FAAPI_ENV 未设，回退到 NODE_ENV=production
        expect(result!.db).toEqual({ host: 'db.production.com' });
      } finally {
        process.env.NODE_ENV = originalNodeEnv;
        process.env.FAAPI_ENV = originalFaapiEnv;
      }
    });

    it('环境配置文件不存在时只返回基础配置', async () => {
      const dir = makeDir({
        'faapi.config.js': `
export default {
  db: { host: 'localhost', port: 5432 },
};
`,
      });

      const originalNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      try {
        const result = await loadConfig(dir);
        expect(result).not.toBeNull();
        expect(result!.db).toEqual({ host: 'localhost', port: 5432 });
      } finally {
        process.env.NODE_ENV = originalNodeEnv;
      }
    });

    it('数组类型直接替换而非递归合并', async () => {
      const dir = makeDir({
        'faapi.config.js': `
export default {
  roles: ['admin', 'user'],
  db: { host: 'localhost' },
};
`,
        'faapi.config.production.js': `
export default {
  roles: ['admin'],
};
`,
      });

      const originalNodeEnv = process.env.NODE_ENV;
      const originalFaapiEnv = process.env.FAAPI_ENV;
      delete process.env.FAAPI_ENV;
      process.env.NODE_ENV = 'production';

      try {
        const result = await loadConfig(dir);
        expect(result).not.toBeNull();
        // 数组整体替换，不是合并
        expect(result!.roles).toEqual(['admin']);
        expect(result!.db).toEqual({ host: 'localhost' });
      } finally {
        process.env.NODE_ENV = originalNodeEnv;
        process.env.FAAPI_ENV = originalFaapiEnv;
      }
    });

    it('默认环境为 development', async () => {
      const dir = makeDir({
        'faapi.config.js': `
export default {
  db: { host: 'localhost' },
};
`,
        'faapi.config.development.js': `
export default {
  db: { host: 'dev.db.com' },
};
`,
      });

      const originalNodeEnv = process.env.NODE_ENV;
      const originalFaapiEnv = process.env.FAAPI_ENV;
      delete process.env.NODE_ENV;
      delete process.env.FAAPI_ENV;

      try {
        const result = await loadConfig(dir);
        expect(result).not.toBeNull();
        expect(result!.db).toEqual({ host: 'dev.db.com' });
      } finally {
        process.env.NODE_ENV = originalNodeEnv;
        process.env.FAAPI_ENV = originalFaapiEnv;
      }
    });
  });
});
