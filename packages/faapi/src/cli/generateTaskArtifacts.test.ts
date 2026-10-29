import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  generateTaskArtifacts,
  serializeTasks,
  hydrateTasks,
  writeTasksModule,
  TASKS_FILE,
} from './generateTaskArtifacts';
import type { TaskManifest } from '../tasks/taskTypes';

let rootDir: string;
const dist = 'dist';

function writeTask(rel: string, source: string): void {
  const abs = path.resolve(rootDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, source);
}

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'faapi-task-artifacts-'));
});

afterEach(() => {
  fs.rmSync(rootDir, { recursive: true, force: true });
});

describe('serializeTasks / hydrateTasks', () => {
  it('filePath 转产物形式，meta 透传，roundtrip 还原', () => {
    const manifests: TaskManifest[] = [
      { name: 'a', filePath: 'src/tasks/a/task.ts', concurrency: 2, retries: 1 },
      { name: 'b', filePath: 'src/tasks/b/task.ts', cron: '0 3 * * *' },
    ];
    const serialized = serializeTasks(manifests, 'dist');
    expect(serialized).toEqual([
      { name: 'a', filePath: 'dist/tasks/a/task.js', concurrency: 2, retries: 1 },
      { name: 'b', filePath: 'dist/tasks/b/task.js', cron: '0 3 * * *' },
    ]);
    const hydrated = hydrateTasks(JSON.parse(JSON.stringify(serialized)));
    expect(hydrated[0]!.name).toBe('a');
    expect(hydrated[0]!.concurrency).toBe(2);
    expect(hydrated[1]!.cron).toBe('0 3 * * *');
  });
});

describe('generateTaskArtifacts', () => {
  it('生成 faapi-tasks.js 清单（含产物路径与 meta）', async () => {
    writeTask(
      'src/tasks/echo/task.ts',
      `export interface Payload {}
export function run(_payload: Payload) {}
`,
    );
    const manifests: TaskManifest[] = [
      { name: 'echo', filePath: 'src/tasks/echo/task.ts', retries: 2 },
    ];
    await generateTaskArtifacts(manifests, rootDir, dist);
    const content = fs.readFileSync(path.resolve(rootDir, dist, TASKS_FILE), 'utf8');
    expect(content).toContain('export const tasks =');
    expect(content).toContain('"name": "echo"');
    expect(content).toContain('"retries": 2');
    expect(content).toContain('dist/tasks/echo/task.js');
  });

  it('run 首参有类型名时生成 zod.js 导出 <TypeName>Schema', async () => {
    writeTask(
      'src/tasks/mail/task.ts',
      `export interface Payload {
  to: string;
}
export function run(payload: Payload) {
  return payload.to;
}
`,
    );
    const manifests: TaskManifest[] = [{ name: 'mail', filePath: 'src/tasks/mail/task.ts' }];
    await generateTaskArtifacts(manifests, rootDir, dist);
    const zodPath = path.resolve(rootDir, dist, 'tasks/mail/zod.js');
    expect(fs.existsSync(zodPath)).toBe(true);
    const source = fs.readFileSync(zodPath, 'utf8');
    expect(source).toContain('PayloadSchema');
    expect(source).toContain("from 'zod'");
  });

  it('type Payload = unknown 显式豁免：生成恒通过的 z.unknown() schema', async () => {
    writeTask(
      'src/tasks/cron-only/task.ts',
      `export type Payload = unknown;
export function run(_payload: Payload) {
  return 'ok';
}
`,
    );
    const manifests: TaskManifest[] = [
      { name: 'cron-only', filePath: 'src/tasks/cron-only/task.ts' },
    ];
    await generateTaskArtifacts(manifests, rootDir, dist);
    const zodPath = path.resolve(rootDir, dist, 'tasks/cron-only/zod.js');
    expect(fs.existsSync(zodPath)).toBe(true);
    const source = fs.readFileSync(zodPath, 'utf8');
    expect(source).toContain('PayloadSchema');
    expect(source).toContain('z.unknown()');
  });

  it('run 首参无类型名：构建期抛错（含任务名与修复指引），不再跳过', async () => {
    writeTask('src/tasks/plain/task.ts', `export function run() {}\n`);
    await expect(
      generateTaskArtifacts(
        [{ name: 'plain', filePath: 'src/tasks/plain/task.ts' }],
        rootDir,
        dist,
      ),
    ).rejects.toThrow(/missing a Payload type declaration/);
    await expect(
      generateTaskArtifacts(
        [{ name: 'plain', filePath: 'src/tasks/plain/task.ts' }],
        rootDir,
        dist,
      ),
    ).rejects.toThrow(/type Payload = unknown/);
  });

  it('run 未导出：构建期抛错（含任务名），不再静默跳过', async () => {
    writeTask('src/tasks/no-run/task.ts', `export function helper() { return 1; }\n`);
    await expect(
      generateTaskArtifacts(
        [{ name: 'no-run', filePath: 'src/tasks/no-run/task.ts' }],
        rootDir,
        dist,
      ),
    ).rejects.toThrow(/no exported run function found/);
  });

  it('无任务时写入空清单', async () => {
    await writeTasksModule([], path.resolve(rootDir, dist, TASKS_FILE));
    const content = fs.readFileSync(path.resolve(rootDir, dist, TASKS_FILE), 'utf8');
    expect(content).toContain('export const tasks = []');
  });

  it('run 第二参无类型标注：不报错（ctx 可省略）', async () => {
    writeTask(
      'src/tasks/no-ctx/task.ts',
      `export interface Payload {}
export function run(payload: Payload) {}
`,
    );
    await expect(
      generateTaskArtifacts(
        [{ name: 'no-ctx', filePath: 'src/tasks/no-ctx/task.ts' }],
        rootDir,
        dist,
      ),
    ).resolves.toBeDefined();
  });
});
