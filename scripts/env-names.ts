/**
 * The naming rules for environment variables, and the frozen list of them in `docs/configuration.md` › "Every variable".
 * The variables come from the Environment sections of the `api.md` snapshots, so the list cannot drift from the code.
 * The rules are in CONTRIBUTING.md › "Environment variables".
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSnapshot } from './api-snapshot.ts';
import { PACKAGE_CODE } from './source-files.ts';

/** The areas a variable belongs to; a variable starts with one of these. */
export const PREFIXES = [
  'APP_', 'AUTH_', 'HASH_', 'CACHE_', 'CSRF_', 'DB_', 'DEVTOOLS_', 'LIVE_', 'LOG_', 'MAIL_', 'NOTIFICATIONS_', 'QUEUE_', 'REDIS_', 'SCHEDULE_',
  'SERVER_', 'SESSION_', 'UPLOADS_', 'MARMEON_OTEL_',
] as const;
/** Set by platforms, so without a prefix. */
export const PLATFORM_NAMES = ['NODE_ENV', 'PORT', 'HOST'] as const;
/** Names the OpenTelemetry specification gives; they are read as it says. */
export const SPECIFICATION_NAMES = ['OTEL_SDK_DISABLED', 'OTEL_INSTRUMENTATION_HTTP_CAPTURE_HEADERS_SERVER_REQUEST'] as const;
export const UNITS = ['MILLISECONDS', 'SECONDS', 'MINUTES', 'HOURS', 'DAYS'] as const;
/** A name with one of these words, exactly, is a duration or a rate of one, and says its unit. Inflections are listed (`EXPIRES`). */
export const DURATION_WORDS = [
  'LIFETIME', 'TIMEOUT', 'DELAY', 'EXPIRE', 'EXPIRES', 'EXPIRY', 'EXPIRATION', 'THROTTLE', 'RETRY', 'HEARTBEAT', 'WITHIN', 'AFTER', 'INTERVAL', 'TTL', 'AGE', 'DURATION',
  'WINDOW', 'PERIOD', 'GRACE', 'IDLE', 'BACKOFF', 'WAIT', 'STALE',
] as const;
/** Abbreviated units, with the long form the name should end with. */
const ABBREVIATED: Readonly<Record<string, string>> = { MS: 'MILLISECONDS', SEC: 'SECONDS', SECS: 'SECONDS', MIN: 'MINUTES', MINS: 'MINUTES', HRS: 'HOURS' };

/** A size says its unit as `_KB` or `_MB` (1,024-based). */
export const SIZE_UNITS = ['KB', 'MB'] as const;
/** Words that name a size without a unit; the name ends with `_KB` or `_MB` instead. */
const SIZE_WORDS = ['SIZE', 'MEMORY', 'BYTES'] as const;
/** Names that end with a size word and are none: each with the reason. */
export const NOT_A_SIZE: Readonly<Record<string, string>> = {
  HASH_SCRYPT_BLOCK_SIZE: "scrypt's r is a factor of the block, not a number of bytes",
};

export type Kind = 'driver' | 'connection' | 'switch' | 'duration' | 'size' | 'value';

export interface EnvName {
  readonly name: string;
  /** The short names of the packages that read it (`auth`, `devtools`), sorted. */
  readonly packages: readonly string[];
  /** The default as the snapshot shows it: `` `900` ``, `required` or `optional`. */
  readonly default: string;
  /** Read by `env.boolean()` and without a default, so the default does not show it. */
  readonly boolean: boolean;
  /** Set when a package reads the variable differently in two configs (the snapshot line names both). */
  readonly divergent?: boolean;
  /** Set when the configs that read it do not agree on its default or on whether it is optional (`default` then lists them). */
  readonly disagreeing?: boolean;
}

export interface EnvNames {
  readonly current: readonly EnvName[];
  /** Retired names, each with its successor and the package that retired it. */
  readonly retired: readonly { readonly name: string; readonly to: string; readonly package: string }[];
}

export interface TableRow {
  readonly name: string;
  readonly packages: string;
  readonly kind: string;
  readonly default: string;
  readonly page: string;
}

/** `` `NAME` = `value` ``, `` `NAME` — required``, `` `NAME` — optional`` or `` `NAME` → `NEW` (renamed)`` (several definitions: the first). */
const LINE = /^`([A-Z][A-Z0-9_]*)` (?:= (`.*?`)(?: \(.*)?$|— (required|optional)( \(boolean\))?.*$|→ `([A-Z][A-Z0-9_]*)` \(renamed\)$)/;

/** The variables and retired names of every `packages/*\/api.md`. */
export function envNames(root: string): EnvNames {
  const current = new Map<string, { packages: Set<string>; defaults: Set<string>; boolean: boolean; divergent: boolean }>();
  const retired: { name: string; to: string; package: string }[] = [];
  for (const dir of readdirSync(join(root, 'packages')).sort()) {
    const file = join(root, 'packages', dir, 'api.md');
    if (!existsSync(file)) continue;
    // Variables of an experimental package sit in its "Experimental" section; commands there start with `marmeon`, no backtick.
    for (const item of parseSnapshot(readFileSync(file, 'utf8'))) {
      if (item.entry !== '' || (item.section !== 'environment' && item.section !== 'experimental')) continue;
      const match = LINE.exec(item.text.split('\n')[0]!);
      if (match === null) continue;
      const [, name, value, word, flag, to] = match as unknown as [string, string, string | undefined, string | undefined, string | undefined, string | undefined];
      if (to !== undefined) {
        retired.push({ name, to, package: dir });
        continue;
      }
      const entry = current.get(name) ?? { packages: new Set<string>(), defaults: new Set<string>(), boolean: false, divergent: false };
      entry.packages.add(dir);
      entry.defaults.add(value ?? word!);
      entry.boolean ||= flag !== undefined;
      entry.divergent ||= /\); /.test(item.text.split('\n')[0]!);
      current.set(name, entry);
    }
  }
  return {
    current: [...current].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, { packages, defaults, boolean, divergent }]) => ({ name, packages: [...packages].sort(), default: [...defaults].join(' / '), boolean, ...(divergent ? { divergent } : {}), ...(defaults.size > 1 ? { disagreeing: true } : {}) })),
    retired: retired.sort((a, b) => (a.name < b.name ? -1 : 1)),
  };
}

/** The rows of the table under `## Every variable` in `docs/configuration.md`. */
export function docsTable(markdown: string): TableRow[] {
  const start = markdown.indexOf('\n## Every variable\n');
  if (start === -1) return [];
  const end = markdown.indexOf('\n## ', start + 1);
  const rows: TableRow[] = [];
  for (const line of markdown.slice(start, end === -1 ? undefined : end).split('\n')) {
    if (!line.startsWith('| `')) continue;
    const cells = line.slice(1, -1).split(' | ').map((cell) => cell.trim());
    const [name, packages, kind, value, page] = cells as [string, string, string, string, string];
    rows.push({ name: name.replace(/^`|`$/g, ''), packages, kind, default: value, page });
  }
  return rows;
}

const lastWord = (name: string): string => name.slice(name.lastIndexOf('_') + 1);
const isSize = (name: string): boolean => (SIZE_UNITS as readonly string[]).includes(lastWord(name));
const isRate = (name: string): boolean => /_PER_(?:SECOND|MINUTE|HOUR|DAY)$/.test(name);
const hasUnit = (name: string): boolean => (UNITS as readonly string[]).includes(lastWord(name));

/** The kind a name and default say it is; the table must name the same. */
export function kindOf(variable: EnvName): Kind {
  const { name } = variable;
  if (name.endsWith('_DRIVER')) return 'driver';
  if (name.endsWith('_CONNECTION')) return 'connection';
  if (variable.boolean || variable.default === '`true`' || variable.default === '`false`' || (SPECIFICATION_NAMES as readonly string[]).includes(name) && variable.default === '`"false"`') return 'switch';
  if (hasUnit(name)) return 'duration';
  if (isSize(name)) return 'size';
  return 'value';
}

/**
 * Every way a variable breaks the rules, or the table differs from the snapshots. Each line names the variable, the rule and the
 * package, and what to do about it.
 */
export function envNameProblems(names: EnvNames, table: readonly TableRow[]): string[] {
  const problems: string[] = [];
  const where = (variable: EnvName) => variable.packages.join(', ');
  const driverDefaults = new Set(names.current.filter(({ name }) => name.endsWith('_DRIVER')).map(({ default: value }) => value));

  for (const variable of names.current) {
    const { name } = variable;
    const specification = (SPECIFICATION_NAMES as readonly string[]).includes(name);
    const fail = (rule: string) => problems.push(`${name} (${where(variable)}): ${rule}`);
    if (!specification && !(PLATFORM_NAMES as readonly string[]).includes(name) && !PREFIXES.some((prefix) => name.startsWith(prefix))) {
      fail(`it starts with no area prefix (${PREFIXES.join(' ')}) and is neither ${PLATFORM_NAMES.join(', ')} nor a name of the OpenTelemetry specification — name it after its area`);
    }
    if (!specification) {
      const words = name.split('_');
      const abbreviation = ABBREVIATED[lastWord(name)];
      if (abbreviation !== undefined) fail(`it ends with the abbreviated unit _${lastWord(name)} — write _${abbreviation}`);
      else if (words.some((word) => (DURATION_WORDS as readonly string[]).includes(word)) && !hasUnit(name) && !isRate(name)) {
        fail(`it names a duration, so it ends with its unit (${UNITS.map((unit) => `_${unit}`).join(', ')}) — rename it and retire the old name with .renamed()`);
      }
      if (isSize(name)) {
        if (variable.default !== 'required' && variable.default !== 'optional' && !/^`\d+`$/.test(variable.default)) fail(`it ends with a size unit, so it is a whole number — its default is ${variable.default}`);
      } else if ((SIZE_WORDS as readonly string[]).includes(lastWord(name)) && NOT_A_SIZE[name] === undefined) {
        fail(`it names a size, so it ends with its unit (${SIZE_UNITS.map((unit) => `_${unit}`).join(', ')}, 1,024-based) and is a whole number — rename it and retire the old name with .renamed()`);
      }
      if (hasUnit(name) && (variable.default === '`true`' || variable.default === '`false`')) fail('it ends with a unit but is a switch');
      if (/^`"(?:true|false|1|0)"`$/i.test(variable.default)) fail('it is a switch read as a string — read it with env.boolean()');
    }
    if (variable.divergent === true) fail('two configs of the package read it differently — one variable has one meaning and one default');
    if (variable.disagreeing === true) fail(`the configs that read it disagree on its default (${variable.default}) — a name has one default in every package, so give them the same or name the variable after its area`);
    if (name.endsWith('_CONNECTION') && driverDefaults.has(variable.default)) fail('_CONNECTION names a database or Redis connection, but its default is that of a _DRIVER variable — a variable that picks a driver ends with _DRIVER');
    if (/DRIVER/.test(name) && !name.endsWith('_DRIVER')) fail('a variable that picks a driver ends with _DRIVER');
    if (/CONNECTION/.test(name) && !name.endsWith('_CONNECTION')) fail('a variable that names a connection ends with _CONNECTION');
  }

  const current = new Set(names.current.map(({ name }) => name));
  for (const { name, to, package: owner } of names.retired) {
    if (current.has(name)) problems.push(`${name} (${owner}): it is retired for ${to} but a config reads it — a retired name is never given out again`);
    if (!current.has(to)) problems.push(`${name} (${owner}): it is retired for ${to}, which no config reads`);
  }

  const documented = new Map(table.map((row) => [row.name, row]));
  for (const row of table) {
    if (!current.has(row.name)) problems.push(`${row.name}: the table in docs/configuration.md lists it, but no api.md has it — remove the row`);
  }
  for (const variable of names.current) {
    const row = documented.get(variable.name);
    const fail = (what: string) => problems.push(`${variable.name} (${where(variable)}): docs/configuration.md › "Every variable" ${what}`);
    if (row === undefined) {
      fail('has no row for it — add one');
      continue;
    }
    const kind = kindOf(variable);
    if (row.packages !== where(variable)) fail(`names the package(s) ${row.packages}, the snapshots say ${where(variable)}`);
    if (row.kind !== kind) fail(`gives the kind ${row.kind}, the name and default say ${kind}`);
    if (row.default !== variable.default) fail(`gives the default ${row.default}, the snapshots say ${variable.default}`);
    if (!/^\[[^\]]+\]\([a-z0-9-]+\.md(?:#[a-z0-9_-]+)?\)$/.test(row.page)) fail(`has no link to a page in the Page column (${row.page})`);
  }
  const seen = new Set<string>();
  for (const row of table) {
    if (seen.has(row.name)) problems.push(`${row.name}: the table in docs/configuration.md lists it twice`);
    seen.add(row.name);
  }
  return problems;
}

/** `env.in(['true', 'false'])` in either order, a `true|false` pattern, and a compare with the word (`.X === 'true'`, `.toLowerCase() === 'true'`). */
const SWITCH_AS_TEXT = [
  /env\.in\(\s*\[(?=[^\]]*['"]true['"])(?=[^\]]*['"]false['"])/,
  /true\|false|false\|true/,
  /(?:\.toLowerCase\(\)|\.[A-Z][A-Z0-9_]+)\s*[!=]==?\s*['"](?:true|false)['"]/,
  /['"](?:true|false)['"]\s*[!=]==?\s*[\w.()]*(?:\.toLowerCase\(\)|\.[A-Z][A-Z0-9_]+)/,
];
/** The specification's own switch is read as the specification says: only `true`, in any case. */
const SPECIFICATION_FILES = ['packages/otel/src/index.ts'];

/** The sources under `packages/*\/src` that read a switch as text — a switch is read with `env.boolean()`. */
export function switchReadAsText(files: ReadonlyMap<string, string>): string[] {
  const problems: string[] = [];
  for (const [path, text] of files) {
    if (PACKAGE_CODE.test(path) && !SPECIFICATION_FILES.includes(path) && SWITCH_AS_TEXT.some((pattern) => pattern.test(text))) {
      problems.push(`${path}: a switch is read as text (env.in(['true', 'false']), a true|false pattern or a compare with 'true') — read it with env.boolean() (${path.split('/')[1]})`);
    }
  }
  return problems;
}

/** Every file under `packages/*\/src`, by its path relative to `root`. */
export function packageSources(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (PACKAGE_CODE.test(path)) files.set(path, readFileSync(join(root, path), 'utf8'));
    }
  };
  for (const name of readdirSync(join(root, 'packages')).sort()) if (existsSync(join(root, 'packages', name, 'src'))) walk(`packages/${name}/src`);
  return files;
}
