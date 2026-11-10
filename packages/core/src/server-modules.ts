import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MARMEON_KEYS } from './discovery/discover.ts';
import { withCode } from './error-codes.ts';

/** A kind of server module: a glob relative to the app root, and what to call such a module in an error. */
export interface ServerModule {
  readonly pattern: string;
  readonly what: string;
}

/**
 * The app's server modules by convention — what client code must never import as a value. Globs relative to the app root;
 * `marmeon({ serverModules })` and package.json's `"marmeon"."serverModules"` add patterns and, with a leading `!`, take some out.
 */
export const SERVER_MODULES: readonly ServerModule[] = [
  { pattern: 'modules/*/controllers/**', what: 'a controller' },
  { pattern: 'modules/*/listeners/**', what: 'a listener' },
  { pattern: 'modules/*/jobs/**', what: 'a job' },
  { pattern: 'modules/*/mail/**', what: 'a mail' },
  { pattern: 'modules/*/notifications/**', what: 'a notification' },
  { pattern: 'modules/*/policies/**', what: 'a policy' },
  { pattern: 'modules/*/middleware/**', what: 'a middleware' },
  { pattern: 'modules/*/tasks/**', what: 'a scheduled task' },
  { pattern: 'modules/*/health/**', what: 'a health check' },
  { pattern: 'modules/*/commands/**', what: 'a command' },
  { pattern: 'modules/*/migrations/**', what: 'a migration' },
  { pattern: 'modules/*/seeders/**', what: 'a seeder' },
  { pattern: 'modules/*/factories/**', what: 'a factory' },
  { pattern: 'modules/*/index.ts', what: "a module's definition (its providers, routes, listeners …)" },
  { pattern: 'modules/*/routes.ts', what: "a module's routes" },
  { pattern: 'modules/*/api-routes.ts', what: "a module's routes" },
  { pattern: 'modules/*/schedule.ts', what: "a module's schedule" },
  { pattern: 'modules/*/config.ts', what: "a module's config (read from the server's environment)" },
  { pattern: '**/*ServiceProvider.ts', what: 'a service provider' },
  { pattern: '**/*Repository.ts', what: 'a repository' },
  { pattern: 'bootstrap/app.ts', what: "the app's definition" },
  { pattern: 'config/**', what: "the app's config (read from the server's environment)" },
  { pattern: 'middleware/**', what: 'a middleware' },
];

const DOCS = 'docs/vite.md#server-folders-of-your-own';

/** Stops with H14 — a declaration that cannot be read is an error, never "no extra patterns", or a typo would switch the check off. */
function refuse(reason: string): never {
  throw new Error(
    withCode(
      'H14',
      `package.json: ${reason}. Until it is fixed, the server-import check and the lint preset cannot know the app's server folders. See ${DOCS}.`,
    ),
  );
}

/** Why `entry` (without a leading `!`) is no glob of the app's files, or `undefined` when it is one. */
function flaw(entry: string, negated: boolean): string | undefined {
  if (entry === '') return 'it is empty';
  if (/^\s|\s$/.test(entry)) return 'it starts or ends with a space';
  if (entry.startsWith('#')) return 'it starts with "#" — an alias is no path; write the folder relative to the app root';
  if (entry.startsWith('/')) return 'it starts with "/" — globs are relative to the app root';
  if (entry.includes('\\')) return 'it uses "\\" — separate folders with "/"';
  if (/[{}]/.test(entry)) return 'it uses braces — list each alternative as its own entry';
  if (/[()|]/.test(entry)) return 'it uses "(", ")" or "|" (an extglob) — list each alternative as its own entry';
  if (entry.includes('!')) return 'it has "!" after its start — only a leading "!" takes files out';
  const segments = entry.split('/');
  if (segments.includes('')) return 'it has an empty segment (a doubled or a trailing "/")';
  if (segments.some((segment) => segment === '.' || segment === '..')) return 'it has a "." or ".." segment';
  const last = segments[segments.length - 1] as string;
  if (!/[*.]/.test(last)) return `it names a folder, which matches no file — write ${JSON.stringify(`${negated ? '!' : ''}${entry}/**`)}`;
  return undefined;
}

/**
 * The server folders the app declares in its package.json, `"marmeon": { "serverModules": [...] }`: globs relative to the app
 * root, `!glob` takes files out of the conventions of `SERVER_MODULES`. Read by the server-import check (dev, build, tests) and the
 * lint preset. No package.json, no `"marmeon"` field or no `"serverModules"` in it declares nothing; anything else that is not a
 * valid declaration — an unreadable file, invalid JSON, a misspelt key, a bad entry — stops with H14, since "no extra patterns" would
 * leave a feature folder unchecked without a word. See docs/vite.md#server-folders-of-your-own.
 */
export function declaredServerModules(root: string): readonly string[] {
  let text: string;
  try {
    text = readFileSync(join(root, 'package.json'), 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return Object.freeze([]);
    return refuse(`cannot be read (${typeof code === 'string' ? code : 'unknown error'})`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return refuse('is not valid JSON');
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return refuse('is not a JSON object');
  if (!Object.hasOwn(json, 'marmeon')) return Object.freeze([]);
  const field = (json as Record<string, unknown>).marmeon;
  if (typeof field !== 'object' || field === null || Array.isArray(field)) {
    return refuse(`"marmeon" is not an object (keys: ${MARMEON_KEYS.join(', ')})`);
  }
  for (const key of Object.keys(field)) {
    if (!(MARMEON_KEYS as readonly string[]).includes(key)) {
      return refuse(`"marmeon" has an unknown key ${JSON.stringify(key).slice(0, 80)} (known: ${MARMEON_KEYS.join(', ')})`);
    }
  }
  // Own properties only: a polluted Object.prototype must not supply a `serverModules` the file does not have.
  if (!Object.hasOwn(field, 'serverModules')) return Object.freeze([]);
  const list = (field as Record<string, unknown>).serverModules;
  if (!Array.isArray(list)) return refuse('"marmeon"."serverModules" is not a list of globs');
  const entries: string[] = [];
  list.forEach((entry: unknown, index: number) => {
    if (typeof entry !== 'string') return refuse(`"marmeon"."serverModules" entry ${index} is not a string`);
    const negated = entry.startsWith('!');
    const reason = flaw(negated ? entry.slice(1) : entry, negated);
    if (reason !== undefined) return refuse(`"marmeon"."serverModules" entry ${index} (${JSON.stringify(entry).slice(0, 80)}): ${reason}`);
    entries.push(entry);
  });
  return Object.freeze(entries);
}
