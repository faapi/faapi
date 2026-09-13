export interface CreateBody {
  token: string;
}

export function POST(ctx, body: CreateBody, tasks) {
  return tasks.enqueue('echo', { token: body.token });
}
