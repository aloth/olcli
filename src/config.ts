/**
 * Configuration management for olcli
 */

import Conf from 'conf';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

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
  if (process.env.OVERLEAF_BASE_URL) {
    return process.env.OVERLEAF_BASE_URL;
  }

  // Check .olauth file in current directory
  const olAuthPath = join(process.cwd(), '.olauth');
  if (existsSync(olAuthPath)) {
    try {
      const content = readFileSync(olAuthPath, 'utf-8').trim();
      if (content.includes('=')) {
        const parts = content.split(';').map(c => c.trim());
        const baseUrlPart = parts.find(c => c.startsWith('baseUrl='));
        if (baseUrlPart) {
          return baseUrlPart.substring('baseUrl='.length);
        }
      }
    } catch {
      // Ignore errors
    }
  }

  return config.get('baseUrl') || 'https://www.overleaf.com';
}

export function setBaseUrl(url: string): void {
  config.set('baseUrl', url);
}

export function getSessionCookieName(): string {
  if (process.env.OVERLEAF_COOKIE_NAME) {
    return process.env.OVERLEAF_COOKIE_NAME;
  }

  // Infer from .olauth file in current directory
  const olAuthPath = join(process.cwd(), '.olauth');
  if (existsSync(olAuthPath)) {
    try {
      const content = readFileSync(olAuthPath, 'utf-8').trim();
      if (content.includes('=')) {
        const parts = content.split(';').map(c => c.trim());
        for (const part of parts) {
          const [key] = part.split('=');
          if (key && key !== 'baseUrl') {
            return key;
          }
        }
      }
    } catch {
      // Ignore errors
    }
  }

  return config.get('sessionCookieName') || 'overleaf_session2';
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
          return sessionCookie.substring(`${cookieName}=`.length);
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
 * Save session cookie in .olauth format for compatibility
 */
export function saveOlAuth(cookie: string, path?: string, customBaseUrl?: string, customCookieName?: string): void {
  const authPath = path || join(process.cwd(), '.olauth');
  const baseUrl = customBaseUrl || getBaseUrl();
  const cookieName = customCookieName || getSessionCookieName();
  
  let content = `${cookieName}=${cookie}`;
  if (baseUrl && baseUrl !== 'https://www.overleaf.com') {
    content += `; baseUrl=${baseUrl}`;
  }
  
  writeFileSync(authPath, content, 'utf-8');
}
