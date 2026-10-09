import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ConfigError, defineConfig, env, environment, type ConfigOf } from '@marmeon/core';
import { devHosts } from '@marmeon/core/dev';
import { DEFAULT_MAX_AGE_HOURS, DEFAULT_MAX_BYTES } from './file-store.ts';

/** The devtools cannot run as configured: forced on in production (E115), or `config/devtools.ts` malformed. */
export class DevtoolsConfigError extends ConfigError {
  override name = 'DevtoolsConfigError';
}

/** What the recorder can watch — `record` lists those it does (default: all). */
export type Watcher = 'requests' | 'queries' | 'jobs' | 'mails' | 'notifications' | 'logs' | 'exceptions' | 'schedule' | 'live' | 'events' | 'commands';

export const WATCHERS: readonly Watcher[] = ['requests', 'queries', 'jobs', 'mails', 'notifications', 'logs', 'exceptions', 'schedule', 'live', 'events', 'commands'];

/** A request path to leave out: exact (`/up`), a prefix ending in `*` (`/_marmeon/live*`), or a pattern. */
export type PathPattern = string | RegExp;

/**
 * The app's devtools settings — the default export of `config/devtools.ts` (optional: the defaults suffice):
 *
 * ```ts
 * import { defineDevtools } from '@marmeon/devtools';
 *
 * export default defineDevtools({
 *   ignore: { paths: ['/_marmeon/live*'], queries: (query) => query.sql.startsWith('pragma') },
 *   slowQueryMs: 100,
 * });
 * ```
 *
 * The file is loaded only where the devtools run (`NODE_ENV=development`), by the devtools themselves — nothing else imports
 * it, so it may import `@marmeon/devtools` while the package is a dev dependency (E115: absent in production installs).
 */
export interface DevtoolsOptions {
  /** What to record (default: everything). */
  readonly record?: readonly Watcher[];
  readonly ignore?: {
    /** Requests not recorded — and nothing of their batch. Added to the defaults (the devtools' own pages, Vite's internals). */
    readonly paths?: readonly PathPattern[];
    /** Statements not recorded. */
    readonly queries?: (query: { readonly sql: string; readonly connection: string }) => boolean;
    /** Commands whose run is no batch — added to the defaults (the long-running ones: `queue:work`, `schedule:work`, `tinker`, …). */
    readonly commands?: readonly string[];
    /** Events (by `static event` or class name) not recorded. */
    readonly events?: readonly string[];
  };
  /** A statement taking at least this long is `slow` (default 100 ms). */
  readonly slowQueryMs?: number;
  /** The least level of a log entry recorded (default `debug`: all). */
  readonly logLevel?: 'debug' | 'info' | 'warn' | 'error';
  readonly storage?: {
    /** `file` (default): NDJSON files every process of the app shares (E116); `memory`: this process only. */
    readonly driver?: 'file' | 'memory';
    /** Relative to the app root (default `storage/framework/devtools`). */
    readonly path?: string;
    /** The ring's size (default 50 MB) and age (default 24 hours). */
    readonly maxBytes?: number;
    readonly maxAgeHours?: number;
  };
}

const DEFINITION: unique symbol = Symbol.for('marmeon.devtools.options');

/** Settings from {@link defineDevtools}. */
export type DevtoolsDefinition = DevtoolsOptions & { readonly [DEFINITION]: true };

/** The app's devtools settings, for `config/devtools.ts` (its default export). */
export function defineDevtools(options: DevtoolsOptions): DevtoolsDefinition {
  for (const watcher of options.record ?? []) {
    if (!WATCHERS.includes(watcher)) throw new DevtoolsConfigError(`defineDevtools({ record }): "${String(watcher)}" is not something the devtools record — ${WATCHERS.join(', ')}.`);
  }
  return Object.freeze({ ...options, [DEFINITION]: true as const });
}

/** The devtools' own pages, Vite's modules and the editor link — never recorded. */
export const DEFAULT_IGNORED_PATHS: readonly PathPattern[] = ['/_marmeon/devtools*', '/@vite/*', '/@id/*', '/@fs/*', '/@react-refresh', '/node_modules/*', '/__open-in-editor*', '/favicon.ico'];

/** Commands that run for long (a batch would never end) or are the devtools' own. */
export const DEFAULT_IGNORED_COMMANDS: readonly string[] = ['queue:work', 'schedule:work', 'tinker', 'serve', 'devtools:clear', 'devtools:prune'];

/** The settings with every default filled in. */
export interface ResolvedDevtoolsOptions {
  readonly record: ReadonlySet<Watcher>;
  readonly ignore: {
    readonly paths: readonly PathPattern[];
    readonly queries?: (query: { readonly sql: string; readonly connection: string }) => boolean;
    readonly commands: ReadonlySet<string>;
    readonly events: ReadonlySet<string>;
  };
  readonly slowQueryMs: number;
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
  readonly storage: { readonly driver: 'file' | 'memory'; readonly path: string; readonly maxBytes: number; readonly maxAgeHours: number };
}

export function resolveOptions(options: DevtoolsOptions = {}, root: string): ResolvedDevtoolsOptions {
  const path = options.storage?.path ?? join('storage', 'framework', 'devtools');
  return {
    record: new Set(options.record ?? WATCHERS),
    ignore: {
      paths: [...DEFAULT_IGNORED_PATHS, ...(options.ignore?.paths ?? [])],
      ...(options.ignore?.queries ? { queries: options.ignore.queries } : {}),
      commands: new Set([...DEFAULT_IGNORED_COMMANDS, ...(options.ignore?.commands ?? [])]),
      events: new Set(options.ignore?.events ?? []),
    },
    slowQueryMs: options.slowQueryMs ?? 100,
    logLevel: options.logLevel ?? 'debug',
    storage: {
      driver: options.storage?.driver ?? 'file',
      path: isAbsolute(path) ? path : join(root, path),
      maxBytes: options.storage?.maxBytes ?? DEFAULT_MAX_BYTES,
      maxAgeHours: options.storage?.maxAgeHours ?? DEFAULT_MAX_AGE_HOURS,
    },
  };
}

/** Whether a request path is left out. */
export function ignoresPath(patterns: readonly PathPattern[], path: string): boolean {
  return patterns.some((pattern) => (typeof pattern === 'string' ? (pattern.endsWith('*') ? path.startsWith(pattern.slice(0, -1)) : path === pattern) : pattern.test(path)));
}

/** The app's `config/devtools.ts`, if it has one — loaded only where the devtools run. */
export async function loadDevtoolsOptions(root: string): Promise<DevtoolsOptions> {
  const file = join(root, 'config', 'devtools.ts');
  if (!existsSync(file)) return {};
  const module = (await import(pathToFileURL(file).href)) as { default?: unknown };
  const options = module.default;
  if (options === undefined || options === null || typeof options !== 'object' || !(DEFINITION in options)) {
    throw new DevtoolsConfigError('config/devtools.ts must `export default defineDevtools({ … })` (from @marmeon/devtools).');
  }
  return options as DevtoolsOptions;
}

/**
 * Whether the devtools run (E115, fail closed): **only** with `NODE_ENV=development` — not "anything but production" (a missing
 * `NODE_ENV`, `test` or `staging` keeps them off). `DEVTOOLS_ENABLED=false` turns them off there too; `DEVTOOLS_ENABLED=true`
 * cannot turn them on anywhere else — where the app is protected (E139: production, staging, no `NODE_ENV`) it fails the start.
 * Tests opt in with `createTestApp(App, { devtools: true })`.
 */
export const DevtoolsConfig = defineConfig('devtools', {
  env: env({
    NODE_ENV: env.string().optional(),
    /** `true` or `false`, in any case. */
    DEVTOOLS_ENABLED: env.string().regex(/^(?:true|false)$/i, 'DEVTOOLS_ENABLED must be true or false.').optional(),
    /** The app's own address: its host may open the pages too (besides `localhost`, `127.0.0.1` and `[::1]`). */
    APP_URL: env.string().optional(),
  }),
  resolve: (e) => {
    const switched = e.DEVTOOLS_ENABLED?.toLowerCase();
    if (switched === 'true' && environment.isProtected(e)) {
      throw new DevtoolsConfigError(
        `DEVTOOLS_ENABLED=true with ${environment.describe(e)}: the devtools record requests, queries and mails — they never run in production, staging or without NODE_ENV. ` +
          'Remove DEVTOOLS_ENABLED (they run with NODE_ENV=development only), and install @marmeon/devtools as a dev dependency.',
      );
    }
    return {
      enabled: environment.isDevelopment(e) && switched !== 'false',
      environment: environment.name(e),
      /** Production, staging, no `NODE_ENV` (E139): a test's opt-in fails the start there. */
      protected: environment.isProtected(e),
      /** `DEVTOOLS_ENABLED=true` in a test: it has no effect (said once, at the start). */
      ineffective: switched === 'true' && !environment.isDevelopment(e),
      /** The hosts the pages answer (a request for any other gets 403 — DNS rebinding): loopback names and `APP_URL`'s host. */
      hosts: devHosts(e.APP_URL),
    };
  },
});
export type DevtoolsConfig = ConfigOf<typeof DevtoolsConfig>;
