import fs from 'node:fs';
import path from 'node:path';

export interface Payload {
  token: string;
}

export const task = {
  concurrency: 1,
  retries: 0,
};

export function run(payload: Payload): { echoed: string } {
  const target = process.env.FAAPI_TASK_ECHO_TARGET;
  if (target) {
    fs.writeFileSync(target, payload.token);
  }
  return { echoed: payload.token };
}
