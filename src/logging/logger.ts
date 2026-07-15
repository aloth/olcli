import { redactValue } from './redact.js';

export type LogSink = (line: string) => void;

export interface LoggerOptions {
  enabled?: boolean;
  unsafeProtocolFrames?: boolean;
  sink?: LogSink;
}

/** A small diagnostic logger that redacts secrets before writing anything. */
export class Logger {
  private enabled: boolean;
  private unsafeProtocolFrames: boolean;
  private readonly sink: LogSink;

  constructor(options: LoggerOptions = {}) {
    this.enabled = options.enabled ?? false;
    this.unsafeProtocolFrames = options.unsafeProtocolFrames ?? false;
    this.sink = options.sink ?? ((line: string) => console.error(line));
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  setUnsafeProtocolFrames(enabled: boolean): void {
    this.unsafeProtocolFrames = enabled;
  }

  debug(event: string, details?: unknown): void {
    if (!this.enabled) return;
    this.write(event, details, false);
  }

  protocol(direction: 'send' | 'receive', frame: unknown): void {
    if (!this.enabled || !this.unsafeProtocolFrames) return;
    this.write(`protocol.${direction}`, frame, true);
  }

  private write(event: string, details: unknown, allowDocumentText: boolean): void {
    const suffix = details === undefined
      ? ''
      : ` ${JSON.stringify(redactValue(details, { allowDocumentText }))}`;
    this.sink(`[olcli] ${event}${suffix}`);
  }
}
