/**
 * Configuration management for olcli
 */

import Conf from 'conf';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Strip ASCII control characters (0x00-0x1F and 0x7F) from a cookie value
 * and trim surrounding whitespace. Returns undefined if the result is empty.
 */
function stripControlChars(value: string): string | undefined {
  const sanitized = value.trim().replace(/[\x00-\x1F\x7F]/g, '');
  return sanitized.length > 0 ? sanitized : undefined;
}

export interface SessionCookieInfo {
  value: string;
  /** Where the cookie was loaded from */
  source: 'env' | '.olauth' | 'config';
}

interface OlcliConfig {
  sessionCookie?: string;
  csrf?: string;
  lastProject?: string;
  baseUrl?: string;
  sessionCookieName?: string;
}

const config = new Conf<OlcliConfig>({
  projectName: 'olcli',
  schema: {
    sessionCookie: { type: 'string' },
    csrf: { type: 'string' },
    lastProject: { type: 'string' },
    baseUrl: { type: 'string' },
    sessionCookieName: { type: 'string' }
  }
});

export function getBaseUrl(): string {
  return process.env.OVERLEAF_BASE_URL || config.get('baseUrl') || 'https://www.overleaf.com';
}

export function setBaseUrl(url: string): void {
  config.set('baseUrl', url);
}

export function getSessionCookieName(): string {
  return process.env.OVERLEAF_COOKIE_NAME || config.get('sessionCookieName') || 'overleaf_session2';
}

export function setSessionCookieName(name: string): void {
  config.set('sessionCookieName', name);
}

/**
 * Get the session cookie along with where it was loaded from.
 * Control characters are stripped and whitespace is trimmed before returning.
 * Returns undefined if no valid cookie is found in any source.
 */
export function getSessionCookieWithSource(): SessionCookieInfo | undefined {
  // Check environment variable first
  if (process.env.OVERLEAF_SESSION) {
    const sanitized = stripControlChars(process.env.OVERLEAF_SESSION);
    if (sanitized) {
      return { value: sanitized, source: 'env' };
    }
  }

  // Check .olauth file in current directory
  const olAuthPath = join(process.cwd(), '.olauth');
  if (existsSync(olAuthPath)) {
    try {
      const content = readFileSync(olAuthPath, 'utf-8').trim();
      // Parse cookie from olauth file (format: key=value or just value)
      let rawValue: string;
      if (content.includes('=')) {
        const cookies = content.split(';').map(c => c.trim());
        const cookieName = getSessionCookieName();
        const sessionCookie = cookies.find(c => c.startsWith(`${cookieName}=`));
        // If the named cookie is found, extract its value; otherwise fall back
        // to the full file content (matches pre-existing behaviour).
        rawValue = sessionCookie ? sessionCookie.split('=')[1] : content;
      } else {
        rawValue = content;
      }
      const sanitized = stripControlChars(rawValue);
      if (sanitized) {
        return { value: sanitized, source: '.olauth' };
      }
    } catch {
      // Ignore errors
    }
  }

  // Check global config
  const stored = config.get('sessionCookie');
  if (stored) {
    const sanitized = stripControlChars(stored);
    if (sanitized) {
      return { value: sanitized, source: 'config' };
    }
  }

  return undefined;
}

export function getSessionCookie(): string | undefined {
  return getSessionCookieWithSource()?.value;
}

export function setSessionCookie(cookie: string): void {
  config.set('sessionCookie', cookie.trim());
}

export function getCsrf(): string | undefined {
  return config.get('csrf');
}

export function setCsrf(csrf: string): void {
  config.set('csrf', csrf);
}

export function getLastProject(): string | undefined {
  return config.get('lastProject');
}

export function setLastProject(projectId: string): void {
  config.set('lastProject', projectId);
}

export function clearConfig(): void {
  config.clear();
}

export function getConfigPath(): string {
  return config.path;
}

/**
 * Save session cookie in .olauth format for compatibility
 */
export function saveOlAuth(cookie: string, path?: string): void {
  const authPath = path || join(process.cwd(), '.olauth');
  writeFileSync(authPath, `${getSessionCookieName()}=${cookie}`, 'utf-8');
}
