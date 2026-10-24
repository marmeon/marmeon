/**
 * Which test files need Postgres, Redis or S3, derived from the source (`vitest.config.ts` turns it into one Vitest project per
 * set of services; `pnpm test:pgsql`, `test:redis` and `test:s3` run the projects that include their service). Nothing is listed
 * by hand and no file is marked: the rules below read the file and the relative imports it reaches. Bare specifiers
 * (`@marmeon/*`, `node:*`, npm) are never followed.
 *
 * A file the rules miss does not lose its coverage silently: every project gets tripwire values for the services it was not
 * selected for (`tripwireEnv`), so `pnpm test` fails with the tripwire's host name when such a file reaches a service.
 * CONTRIBUTING.md, "The test suites against real services".
 *
 * This file names the variables only in pieces, so that the test of this file — which imports it — is not selected for a service
 * by its own rules.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';

export type Service = 'pgsql' | 'redis' | 's3';

export const SERVICES: readonly Service[] = ['pgsql', 'redis', 's3'];

/** The variable whose presence switches a service's cases on (rule 1). */
export const SERVICE_VARIABLES: Record<Service, string> = {
  pgsql: `MARMEON_TEST_${'PGSQL_URL'}`,
  redis: `MARMEON_TEST_${'REDIS_URL'}`,
  s3: `MARMEON_TEST_${'S3_ENDPOINT'}`,
};

const FIXTURE_ERROR = 'import fixtures relatively — the service selection cannot see through a package specifier';

/** Static imports and exports with a source, side-effect imports, and dynamic imports with a literal. */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"\n]+)\1/g;

/** A test app on a refreshed database (rule 2). */
const REFRESH = /database:\s*'refresh'/;

/** A nested Vitest started from a test (rule 4). */
const NESTED_VITEST = /node_modules\/\.bin\/vitest/;

/**
 * Test and helper files, as opposed to the production code of a package: a refresh named in a package's `src` is the text of an
 * error message, in a test or helper it is a test app on a database.
 */
export function isTestOrHelper(path: string): boolean {
  const parts = path.split('/');
  return (
    /\.test\.tsx?$/.test(path) ||
    /\.test-support\.tsx?$/.test(path) ||
    parts.includes('__fixtures__') ||
    parts.includes('test-helpers') ||
    parts[0] === 'apps' ||
    parts[0] === 'scripts'
  );
}

/** The relative specifiers in `source`; throws on a package specifier that reaches into a `__fixtures__` directory. */
function specifiers(source: string, file: string): string[] {
  const relativeOnes: string[] = [];
  for (const match of source.matchAll(SPECIFIER)) {
    const specifier = match[2]!;
    if (specifier.startsWith('./') || specifier.startsWith('../')) relativeOnes.push(specifier);
    else if (specifier.includes('__fixtures__')) throw new Error(`${file}: '${specifier}' — ${FIXTURE_ERROR}`);
  }
  return relativeOnes;
}

/** The TypeScript sources a `.js`-style specifier may stand for. */
const JS_TO_TS: Record<string, string[]> = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] };

/** Resolves a relative specifier the way TypeScript does; `undefined` for anything that is not a source file (JSON, CSS, …). */
function resolveSource(from: string, specifier: string): string | undefined {
  const base = resolve(dirname(from), specifier);
  const candidates = [base, ...(JS_TO_TS[extname(base)] ?? []).map((extension) => base.slice(0, -extname(base).length) + extension), `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')];
  return candidates.find((candidate) => /\.[mc]?[jt]sx?$/.test(candidate) && existsSync(candidate) && statSync(candidate).isFile());
}

/** Whether the `package.json` in `directory` depends on `@marmeon/database`. */
function usesDatabase(directory: string, cache: Map<string, boolean>): boolean {
  let result = cache.get(directory);
  if (result === undefined) {
    try {
      const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
      result = Boolean(manifest.dependencies?.['@marmeon/database'] ?? manifest.devDependencies?.['@marmeon/database']);
    } catch {
      result = false;
    }
    cache.set(directory, result);
  }
  return result;
}

/**
 * The services each test file needs; a file that needs none is in the map with an empty set. `files` are paths relative to
 * `root`. Reads files and starts nothing.
 *
 * Postgres:
 * 1. A file in the import closure reads the Postgres URL variable — its cases run when it is set.
 * 2. A test or helper file in the closure builds a refreshed test app — with `DB_DRIVER=pgsql` in the environment such an
 *    app uses Postgres, whatever the file says about it.
 * 3. The test sits in an app that depends on `@marmeon/database` — `loadEnv` lets `DB_DRIVER` from the environment win over
 *    the app's `.env`, so the app's own database is Postgres.
 * 4. A test or helper file starts a nested Vitest — its refresh tests inherit `DB_DRIVER`.
 *
 * Redis and S3: rule 1 with their variables.
 *
 * Throws on a package specifier that names a `__fixtures__` directory: the closure cannot follow it, and a fixture left out
 * would drop its service from the selection.
 */
export function serviceFiles(root: string, files: readonly string[]): Map<string, ReadonlySet<Service>> {
  const texts = new Map<string, string>();
  const imports = new Map<string, string[]>();
  const manifests = new Map<string, boolean>();
  const pathOf = (absolute: string): string => relative(root, absolute).split(sep).join('/');

  const read = (absolute: string): string => {
    let text = texts.get(absolute);
    if (text === undefined) {
      text = readFileSync(absolute, 'utf8');
      texts.set(absolute, text);
    }
    return text;
  };
  const importsOf = (absolute: string): string[] => {
    let found = imports.get(absolute);
    if (found === undefined) {
      found = specifiers(read(absolute), pathOf(absolute)).flatMap((specifier) => resolveSource(absolute, specifier) ?? []);
      imports.set(absolute, found);
    }
    return found;
  };

  const result = new Map<string, ReadonlySet<Service>>();
  for (const file of files) {
    const closure = new Set<string>();
    const pending = [resolve(root, file)];
    while (pending.length > 0) {
      const next = pending.pop()!;
      if (closure.has(next)) continue;
      closure.add(next);
      pending.push(...importsOf(next));
    }

    const needed = new Set<Service>();
    for (const absolute of closure) {
      const text = read(absolute);
      for (const service of SERVICES) if (text.includes(SERVICE_VARIABLES[service])) needed.add(service);
      if (isTestOrHelper(pathOf(absolute)) && (REFRESH.test(text) || NESTED_VITEST.test(text))) needed.add('pgsql');
    }
    const [top, app] = file.split('/');
    if (top === 'apps' && app && usesDatabase(join(root, top, app), manifests)) needed.add('pgsql');
    result.set(file, needed);
  }
  return result;
}

/** A test file that asserts something about wall-clock time: it runs in the `timing` project, last and alone, and never needs a service. */
export const TIMING = /\.timing\.test\.tsx?$/;

/** `files` split into the timing tests and the rest; only the rest goes to {@link serviceFiles}. */
export function splitTiming(files: readonly string[]): { timing: string[]; other: string[] } {
  return { timing: files.filter((file) => TIMING.test(file)), other: files.filter((file) => !TIMING.test(file)) };
}

/** The name of a project: its services sorted and joined with `+`, or `plain`. */
export function projectName(services: ReadonlySet<Service>): string {
  return services.size === 0 ? 'plain' : [...services].sort().join('+');
}

export interface ServiceGroup {
  readonly services: ReadonlySet<Service>;
  readonly files: string[];
}

/** Groups test files by the set of services they need, keyed by project name. */
export function groupByServices(selection: ReadonlyMap<string, ReadonlySet<Service>>): Map<string, ServiceGroup> {
  const groups = new Map<string, ServiceGroup>();
  for (const [file, services] of [...selection].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const name = projectName(services);
    const group = groups.get(name) ?? { services, files: [] };
    group.files.push(file);
    groups.set(name, group);
  }
  return groups;
}

/**
 * The `test.env` of a project that was selected for `services`: values for every other service that fail loudly where a real run
 * would connect. The host names end in `.invalid`, which never resolves (RFC 6761), so no connection to a service is opened. A file that
 * needs a service the rules do not see turns `pnpm test` red with the host name in the error, instead of losing its Postgres,
 * Redis or S3 coverage unnoticed.
 */
export function tripwireEnv(services: ReadonlySet<Service>): Record<string, string> {
  const env: Record<string, string> = {};
  if (!services.has('pgsql')) {
    const url = 'postgres://tripwire@not-selected-for-test-pgsql.invalid/marmeon';
    Object.assign(env, { DB_DRIVER: 'pgsql', DB_URL: url, [SERVICE_VARIABLES.pgsql]: url });
  }
  if (!services.has('redis')) env[SERVICE_VARIABLES.redis] = 'redis://not-selected-for-test-redis.invalid:6379';
  if (!services.has('s3')) env[SERVICE_VARIABLES.s3] = 'http://not-selected-for-test-s3.invalid';
  return env;
}

/**
 * The `test.env` of the `timing` project: SQLite, pinned against a `DB_DRIVER` in the shell, and the tripwires of all three services
 * (the Postgres one as the variable only — the web app's tests need the driver to stay SQLite).
 */
export function timingEnv(): Record<string, string> {
  return { ...tripwireEnv(new Set<Service>(['pgsql'])), DB_DRIVER: 'sqlite', [SERVICE_VARIABLES.pgsql]: 'postgres://tripwire@not-selected-for-test-pgsql.invalid/marmeon' };
}
