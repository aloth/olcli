import { OlcliError } from './olcli-error.js';

export interface SerializedOlcliError {
  name: string;
  message: string;
  code?: string;
  details?: Record<string, unknown>;
}

export function serializeError(error: unknown): SerializedOlcliError {
  if (error instanceof OlcliError) {
    return {
      name: error.name,
      message: error.message,
      code: error.code,
      details: error.details,
    };
  }
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { name: 'Error', message: String(error) };
}
