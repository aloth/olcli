/**
 * Configuration management for olcli
 */

import Conf from 'conf';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface OlcliConfig {
  sessionCookie?: string;
  csrf?: string;
  lastProject?: string;
  baseUrl?: string;
  sessionCookieName?: string;
  timeout?: number;
  loginEmail?: string;
  loginPassword?: string;
}

export interface PasswordCredentials {
  email: string;
  password: string;
}

const config = new Conf<OlcliConfig>({
  projectName: 'olcli',
  schema: {
    sessionCookie: { type: 'string' },
    csrf: { type: 'string' },
    lastProject: { type: 'string' },
    baseUrl: { type: 'string' },
    sessionCookieName: { type: 'string' },
    timeout: { type: 'number' },
    loginEmail: { type: 'string' },
    loginPassword: { type: 'string' }
  }
});

export function getBaseUrl(): string {
  return process.env.OVERLEAF_BASE_URL || config.get('baseUrl') || 'https://www.overleaf.com';
}

export function setBaseUrl(url: string): void {
  config.set('baseUrl', url);
}

export function getTimeout(): number {
  return Number.parseInt(process.env.OVERLEAF_TIMEOUT || '') || config.get('timeout') || 10000;
}

export function setTimeout(ms: number): void {
  config.set('timeout', ms);
}

export function getPasswordCredentials(): PasswordCredentials | undefined {
  const email = process.env.OVERLEAF_EMAIL || config.get('loginEmail');
  const password = process.env.OVERLEAF_PASSWORD || config.get('loginPassword');
  if (!email || !password) return undefined;
  return { email, password };
}

export function setPasswordCredentials(email: string, password: string): void {
  config.set('loginEmail', email);
  config.set('loginPassword', password);
}

export function clearPasswordCredentials(): void {
  config.delete('loginEmail');
  config.delete('loginPassword');
}

export function getSessionCookieName(): string {
  return process.env.OVERLEAF_COOKIE_NAME || config.get('sessionCookieName') || 'overleaf_session2';
}

export function setSessionCookieName(name: string): void {
  config.set('sessionCookieName', name);
}

export function getSessionCookie(): string | undefined {
  // Check environment variable first
  if (process.env.OVERLEAF_SESSION) {
    return process.env.OVERLEAF_SESSION;
  }

  // Check .olauth file in current directory
  const olAuthPath = join(process.cwd(), '.olauth');
  if (existsSync(olAuthPath)) {
    try {
      const content = readFileSync(olAuthPath, 'utf-8').trim();
      // Parse cookie from olauth file (format: key=value or just value)
      if (content.includes('=')) {
        const cookies = content.split(';').map(c => c.trim());
        const cookieName = getSessionCookieName();
        const sessionCookie = cookies.find(c => c.startsWith(`${cookieName}=`));
        if (sessionCookie) {
          return sessionCookie.split('=')[1];
        }
      }
      return content;
    } catch {
      // Ignore errors
    }
  }

  // Check global config
  return config.get('sessionCookie');
}

export function setSessionCookie(cookie: string): void {
  config.set('sessionCookie', cookie);
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
 * Where a `.olauth` file would live for a given directory.
 *
 * Defaults to the current working directory, which is what `saveOlAuth` and
 * `getSessionCookie` both use.
 */
export function getOlAuthPath(dir?: string): string {
  return join(dir || process.cwd(), '.olauth');
}

/**
 * Save session cookie in .olauth format for compatibility
 */
export function saveOlAuth(cookie: string, path?: string): void {
  const authPath = path || getOlAuthPath();
  writeFileSync(authPath, `${getSessionCookieName()}=${cookie}`, 'utf-8');
}

/**
 * Delete the `.olauth` file for a directory, if there is one.
 *
 * Returns the path that was removed, or null when there was nothing to
 * remove. `logout` needs the distinction to report what it actually did.
 */
export function clearOlAuth(dir?: string): string | null {
  const authPath = getOlAuthPath(dir);
  if (!existsSync(authPath)) return null;
  rmSync(authPath);
  return authPath;
}

/**
 * What credentials exist right now, and where.
 *
 * Deliberately reports every source `getSessionCookie` and
 * `getPasswordCredentials` consult, including the two that no command can
 * clear. `logout` used to clear the global config and announce success while
 * a `.olauth` file - which takes precedence over it - stayed on disk and kept
 * the user authenticated. Reporting per source is what stops that message
 * from being wrong again. See issue #50.
 */
export interface StoredCredentials {
  /** Session cookie in the global config file. */
  sessionCookie: boolean;
  /** Email/password pair in the global config file. */
  password: boolean;
  /** Path of the `.olauth` file, when one exists. Takes precedence over the config. */
  olAuthPath: string | null;
  /** `OVERLEAF_SESSION` is set. Takes precedence over everything, and logout cannot unset it. */
  envSession: boolean;
  /** `OVERLEAF_EMAIL`/`OVERLEAF_PASSWORD` are set. Same caveat. */
  envPassword: boolean;
}

export function inspectStoredCredentials(dir?: string): StoredCredentials {
  const authPath = getOlAuthPath(dir);
  return {
    sessionCookie: Boolean(config.get('sessionCookie')),
    password: Boolean(config.get('loginEmail') || config.get('loginPassword')),
    olAuthPath: existsSync(authPath) ? authPath : null,
    envSession: Boolean(process.env.OVERLEAF_SESSION),
    envPassword: Boolean(process.env.OVERLEAF_EMAIL && process.env.OVERLEAF_PASSWORD)
  };
}
