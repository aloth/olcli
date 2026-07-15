import type { OlcliErrorCode } from './codes.js';

export class OlcliError extends Error {
  readonly code: OlcliErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: OlcliErrorCode,
    message: string,
    options: { cause?: unknown; details?: Record<string, unknown> } = {}
  ) {
    super(message, { cause: options.cause });
    this.name = 'OlcliError';
    this.code = code;
    this.details = options.details;
  }
}
