import { readFileSync } from 'node:fs';

/** The version of the `marmeon` package, from its manifest (next to `src/` and `dist/`). */
export function packageVersion(): string {
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: unknown };
  return typeof manifest.version === 'string' ? manifest.version : '0.0.0';
}
