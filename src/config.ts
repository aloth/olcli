/**
 * Configuration management for olcli
 */

import Conf from 'conf';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

interface OlcliConfig {
  sessions?: Record<string, string>;
  sessionCookie?: string;
  csrf?: string;
  lastProject?: string;
  baseUrl?: string;
  sessionCookieName?: string;
}

const config = new Conf<OlcliConfig>({
  projectName: 'olcli',
  schema: {
    sessions: {},
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

export function getSession(baseUrl: string): string | undefined {
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
  //const normalizedUrl = baseUrl.replace(/\/$/, '');
  const sessions = config.get('sessions') || {};
  return sessions[baseUrl || 'https://www.overleaf.com'];
  //return config.get('sessionCookie');
}

export function setSession(baseUrl:string, cookie: string): void {
  const sessions = config.get('sessions') || {};

  sessions[baseUrl] = cookie;
  config.set('sessions', sessions);
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
 * Save session cookie in .olauth format for compatibility
 */
export function saveOlAuth(cookie: string, path?: string): void {
  const authPath = path || join(process.cwd(), '.olauth');
  writeFileSync(authPath, `${getSessionCookieName()}=${cookie}`, 'utf-8');
}
