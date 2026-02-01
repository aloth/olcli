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
}

const config = new Conf<OlcliConfig>({
  projectName: 'olcli',
  schema: {
    sessionCookie: { type: 'string' },
    csrf: { type: 'string' },
    lastProject: { type: 'string' }
  }
});

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
        const sessionCookie = cookies.find(c => c.startsWith('overleaf_session2='));
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
 * Save session cookie in .olauth format for compatibility
 */
export function saveOlAuth(cookie: string, path?: string): void {
  const authPath = path || join(process.cwd(), '.olauth');
  writeFileSync(authPath, `overleaf_session2=${cookie}`, 'utf-8');
}
