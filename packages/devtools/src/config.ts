import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ConfigError, defineConfig, type ConfigOf } from '@bespokecore/core';
import * as v from 'valibot';
import { DEFAULT_MAX_AGE_HOURS, DEFAULT_MAX_BYTES } from './file-store.ts';

/** The devtools cannot run as configured: forced on in production (E115), or `config/devtools.ts` malformed. */
export class DevtoolsConfigError extends ConfigError {
  override name = 'DevtoolsConfigError';
}

/** What the recorder can watch — `record` lists those it does (default: all). */
export type Watcher = 'requests' | 'queries' | 'jobs' | 'mails' | 'notifications' | 'logs' | 'exceptions' | 'schedule' | 'live' | 'events' | 'commands';

export const WATCHERS: readonly Watcher[] = ['requests', 'queries', 'jobs', 'mails', 'notifications', 'logs', 'exceptions', 'schedule', 'live', 'events', 'commands'];

/** A request path to leave out: exact (`/up`), a prefix ending in `*` (`/_bespoke/live*`), or a pattern. */
export type PathPattern = string | RegExp;

/**
 * The app's devtools settings — the default export of `config/devtools.ts` (optional: the defaults suffice):
 *
 * ```ts
 * import { defineDevtools } from '@bespokecore/devtools';
 *
 * export default defineDevtools({
 *   ignore: { paths: ['/_bespoke/live*'], queries: (query) => query.sql.startsWith('pragma') },
 *   slowQueryMs: 100,
 * });
 * ```
 *
 * The file is loaded only where the devtools run (`NODE_ENV=development`), by the devtools themselves — nothing else imports
 * it, so it may import `@bespokecore/devtools` while the package is a dev dependency (E115: absent in production installs).
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

const DEFINITION: unique symbol = Symbol.for('bespokecore.devtools.options');

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
export const DEFAULT_IGNORED_PATHS: readonly PathPattern[] = ['/_bespoke/devtools*', '/@vite/*', '/@id/*', '/@fs/*', '/@react-refresh', '/node_modules/*', '/__open-in-editor*', '/favicon.ico'];

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
    throw new DevtoolsConfigError('config/devtools.ts must `export default defineDevtools({ … })` (from @bespokecore/devtools).');
  }
  return options as DevtoolsOptions;
}

/**
 * Whether the devtools run (E115, fail closed): **only** with `NODE_ENV=development` — not "anything but production" (a missing
 * `NODE_ENV`, `test` or `staging` keeps them off). `DEVTOOLS_ENABLED=false` turns them off there too; `DEVTOOLS_ENABLED=true`
 * cannot turn them on anywhere else — in production it fails the start. Tests opt in with `createTestApp(App, { devtools: true })`.
 */
export const DevtoolsConfig = defineConfig('devtools', {
  env: v.object({
    NODE_ENV: v.optional(v.string()),
    DEVTOOLS_ENABLED: v.optional(v.pipe(v.string(), v.toLowerCase(), v.picklist(['true', 'false']))),
    /** The app's own address: its host may open the pages too (besides `localhost`, `127.0.0.1` and `[::1]`). */
    APP_URL: v.optional(v.string()),
  }),
  resolve: (env) => {
    if (env.DEVTOOLS_ENABLED === 'true' && env.NODE_ENV === 'production') {
      throw new DevtoolsConfigError(
        'DEVTOOLS_ENABLED=true with NODE_ENV=production: the devtools record requests, queries and mails — they never run in production (E115). ' +
          'Remove DEVTOOLS_ENABLED (they run with NODE_ENV=development only), and install @bespokecore/devtools as a dev dependency.',
      );
    }
    return {
      enabled: env.NODE_ENV === 'development' && env.DEVTOOLS_ENABLED !== 'false',
      environment: env.NODE_ENV,
      /** `DEVTOOLS_ENABLED=true` outside development: it has no effect (said once, at the start). */
      ineffective: env.DEVTOOLS_ENABLED === 'true' && env.NODE_ENV !== 'development',
      /** The hosts the pages answer (a request for any other gets 403 — DNS rebinding): loopback names and `APP_URL`'s host. */
      hosts: allowedHosts(env.APP_URL),
    };
  },
});
export type DevtoolsConfig = ConfigOf<typeof DevtoolsConfig>;

/** The loopback names — always allowed. */
export const LOOPBACK_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '[::1]'];

/** The host names the devtools' pages answer: the loopback ones and the host of `appUrl` (lower case, no port). */
export function allowedHosts(appUrl: string | undefined): ReadonlySet<string> {
  const hosts = new Set(LOOPBACK_HOSTS);
  if (appUrl) {
    try {
      hosts.add(new URL(appUrl).hostname.toLowerCase());
    } catch {
      // Not a URL: only the loopback names (the app's own config reports a broken APP_URL).
    }
  }
  return hosts;
}
