import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

/** The variables of one env file — `{}` when there is none. No dependencies besides Node: `environment.ts` loads before the injection hook. */
export function readEnvFile(path: string): Record<string, string | undefined> {
  return existsSync(path) ? parseEnv(readFileSync(path, 'utf8')) : {};
}
