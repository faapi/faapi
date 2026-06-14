import type { ErrorCode } from './errorCodes';

export class FaapiError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'FaapiError';
  }
}
