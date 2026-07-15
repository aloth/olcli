import { redactValue, type RedactionOptions } from '../logging/redact.js';

export interface ProtocolFixtureMetadata {
  schemaVersion: 1;
  capturedAt: string;
  instance: 'overleaf-cloud' | 'self-hosted';
  operation: string;
  otType?: 'sharejs-text-ot' | 'history-ot';
  sanitized: true;
  notes?: string;
}

export interface ProtocolFixture {
  metadata: ProtocolFixtureMetadata;
  exchange: unknown;
}

export interface SanitizeFixtureOptions extends RedactionOptions {
  idPlaceholder?: string;
}

const OBJECT_ID = /\b[a-f0-9]{24}\b/gi;

function replaceObjectIds(serialized: string, fixedPlaceholder?: string): string {
  const replacements = new Map<string, string>();
  return serialized.replace(OBJECT_ID, match => {
    const key = match.toLowerCase();
    const existing = replacements.get(key);
    if (existing) return existing;
    const placeholder = fixedPlaceholder
      || (replacements.size + 1).toString(16).padStart(24, '0');
    replacements.set(key, placeholder);
    return placeholder;
  });
}

/**
 * Sanitize a captured protocol exchange before it is written to disk.
 * Callers must pass real source strings in `privateValues` when the exchange
 * contains serialized frames, since arbitrary LaTeX cannot be auto-detected.
 */
export function sanitizeProtocolFixture(
  fixture: Omit<ProtocolFixture, 'metadata'> & { metadata: Omit<ProtocolFixtureMetadata, 'sanitized'> },
  options: SanitizeFixtureOptions = {}
): ProtocolFixture {
  const redacted = redactValue({
    metadata: fixture.metadata,
    exchange: fixture.exchange,
  }, options);
  const sanitized = JSON.parse(
    replaceObjectIds(JSON.stringify(redacted), options.idPlaceholder)
  ) as {
    metadata: Omit<ProtocolFixtureMetadata, 'sanitized'>;
    exchange: unknown;
  };

  return {
    metadata: { ...sanitized.metadata, sanitized: true },
    exchange: sanitized.exchange,
  };
}
