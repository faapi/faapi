import { InternalError } from '@faapi/faapi';

export function GET() {
  throw new InternalError('faapi error 5xx');
}
