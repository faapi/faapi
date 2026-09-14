import fs from 'node:fs';
import path from 'node:path';

export interface Payload {
  token: string;
}

export const task = {
  concurrency: 1,
  retries: 0,
  timeoutMs: 60_000, // 最小 60s（扫描期校验）——本任务毫秒级完成，超时只是上限保护
};

export function run(payload: Payload): { echoed: string } {
  const target = process.env.FAAPI_TASK_ECHO_TARGET;
  if (target) {
    fs.writeFileSync(target, payload.token);
  }
  return { echoed: payload.token };
}
