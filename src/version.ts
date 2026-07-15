import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(
  readFileSync(join(directory, '..', 'package.json'), 'utf8')
) as { name: string; version: string };

export const PACKAGE_NAME = packageJson.name;
export const PACKAGE_VERSION = packageJson.version;
