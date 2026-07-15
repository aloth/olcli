const REDACTED = '[REDACTED]';

const EMAIL_KEY = /^(?:email|user_email|owner_email)$/i;
const DOCUMENT_TEXT_KEY = /^(?:body|content|document|documenttext|document_text|frame|latex|lines|message|source|source_text|text)$/i;

const COOKIE_VALUE = /\b(overleaf_session2|overleaf\.sid|sharelatex\.sid)=([^;\s]+)/gi;
const AUTHORIZATION_VALUE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const CSRF_VALUE = /([?&](?:_?csrf|csrfToken|x-csrf-token)=)[^&#\s]+/gi;
const NAMED_SECRET_VALUE = /(["']?(?:_?csrf|csrfToken|x-csrf-token|password|access_token|refresh_token)["']?\s*[:=]\s*["']?)[^"',;\s}]+/gi;
const EMAIL_VALUE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

export interface RedactionOptions {
  allowDocumentText?: boolean;
  allowEmails?: boolean;
  privateValues?: readonly string[];
}

function redactText(value: string, options: RedactionOptions): string {
  let redacted = value
    .replace(COOKIE_VALUE, '$1=[REDACTED]')
    .replace(AUTHORIZATION_VALUE, '$1 [REDACTED]')
    .replace(CSRF_VALUE, '$1[REDACTED]')
    .replace(NAMED_SECRET_VALUE, '$1[REDACTED]');

  if (!options.allowEmails) {
    redacted = redacted.replace(EMAIL_VALUE, '[REDACTED_EMAIL]');
  }

  for (const privateValue of options.privateValues || []) {
    if (privateValue) {
      redacted = redacted.split(privateValue).join(`[REDACTED_TEXT:${privateValue.length}]`);
    }
  }

  return redacted;
}

function isSecretKey(key: string): boolean {
  const normalized = key.replace(/[-_]/g, '').toLowerCase();
  return normalized === 'authorization'
    || normalized === 'cookie'
    || normalized === 'setcookie'
    || normalized === 'csrf'
    || normalized === 'csrftoken'
    || normalized === 'xcsrftoken'
    || normalized === 'password'
    || normalized === 'passwd'
    || normalized === 'loginpassword'
    || normalized === 'session'
    || normalized === 'sessioncookie'
    || normalized === 'token'
    || normalized === 'accesstoken'
    || normalized === 'refreshtoken';
}

function documentPlaceholder(value: unknown): unknown {
  if (typeof value === 'string') return `[REDACTED_TEXT:${value.length}]`;
  if (Array.isArray(value)) {
    return value.map(item => documentPlaceholder(item));
  }
  return '[REDACTED_TEXT]';
}

/**
 * Return a redacted clone suitable for diagnostics and committed fixtures.
 * The input is never mutated.
 */
export function redactValue(value: unknown, options: RedactionOptions = {}): unknown {
  const seen = new WeakSet<object>();

  const visit = (current: unknown, key?: string): unknown => {
    if (key && isSecretKey(key)) return REDACTED;
    if (key && EMAIL_KEY.test(key) && !options.allowEmails) return '[REDACTED_EMAIL]';
    if (key && DOCUMENT_TEXT_KEY.test(key) && !options.allowDocumentText) {
      return documentPlaceholder(current);
    }

    if (typeof current === 'string') return redactText(current, options);
    if (current === null || typeof current !== 'object') return current;

    if (seen.has(current)) return '[CIRCULAR]';
    seen.add(current);

    if (Array.isArray(current)) {
      return current.map(item => visit(item));
    }

    return Object.fromEntries(
      Object.entries(current as Record<string, unknown>).map(([childKey, childValue]) => [
        childKey,
        visit(childValue, childKey),
      ])
    );
  };

  return visit(value);
}

export function redactString(value: string, options: RedactionOptions = {}): string {
  return redactText(value, options);
}
