/**
 * What `NODE_ENV` means to the framework — the one place that decides it (E115, E139, E217), and where it comes from (E170).
 *
 * `NODE_ENV` is `development`, `test` or `production` — nothing else: any other value stops the start ({@link environment.check},
 * called by `marmeon` before a command loads, by `createApplication` and by `startServer`), with the hint to set
 * `NODE_ENV=production` and name the environment in `APP_ENV`. A missing `NODE_ENV` is `production`. Two rules, and they are
 * not mirror images of each other:
 * - **Development tools** (Vite's dev server, the error page's details, the devtools, `Server-Timing`, the mail previews,
 *   pretty logs, regenerated table types) run **only** with `NODE_ENV=development` — never with "anything but production".
 * - **Protections** (JSON logs, `migrate` asking for `--force`, the boot warnings, no lab pages) apply to `production` — and,
 *   fail-closed, to everything but `development` and `test`: a missing `NODE_ENV`, and any other value a check let through.
 *
 * **`APP_ENV`** names the app's environment — `local`, `staging`, `production` or a name of your own; without it `development`
 * is `local`, `test` is `testing` and `production` is `production` ({@link environment.app}). It is shown — the start line, a
 * field of every JSON log entry, the spans' `deployment.environment.name`, the devtools' header — and it selects the scheduled
 * tasks (`.environments(…)`, E221). It never weakens a protection or enables a development tool — a staging server is
 * `NODE_ENV=production APP_ENV=staging`.
 *
 * **Where `NODE_ENV` comes from** ({@link resolveEnvironment}, E170): the process's `NODE_ENV` — else the one in the app's `.env`
 * (only the base file: `.env.{NODE_ENV}` is chosen by it and cannot define it) — else none, which is production (`marmeon start`
 * and `marmeon build` then set `production`). The resolved value is written to `process.env.NODE_ENV` once, at the start of the
 * process, so config definitions, the CLI and the server all read the same one; a value taken from `.env` is marked as such and
 * named wherever the environment is shown (`development (APP_ENV=local, NODE_ENV from .env)`).
 *
 * Every function reads `process.env` unless given the environment a config definition resolves from (`env` of `defineConfig`).
 * This module has no dependencies besides Node: `marmeon` loads it (`@marmeon/core/environment`) before the injection hook.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

export interface NodeEnvironment {
  readonly NODE_ENV?: string | undefined;
  readonly APP_ENV?: string | undefined;
  readonly [DOTENV_MARKER]?: string | undefined;
}

/** Set next to `NODE_ENV` when its value came from `.env` (holds that value, so a later explicit `NODE_ENV` is never mistaken). */
export const DOTENV_MARKER = 'MARMEON_NODE_ENV_FROM_DOTENV';

/** The values `NODE_ENV` may have — any other stops the start. */
export const NODE_ENVIRONMENTS = ['development', 'test', 'production'] as const;
export type NodeEnvironmentName = (typeof NODE_ENVIRONMENTS)[number];

/** `APP_ENV` when it is not set: the name that goes with `NODE_ENV`. */
const APP_ENVIRONMENTS: Readonly<Record<NodeEnvironmentName, string>> = { development: 'local', test: 'testing', production: 'production' };

/** The error a start fails with when its configuration is wrong — `NODE_ENV` here, the variables in `defineConfig`. */
export class ConfigError extends Error {
  override name = 'ConfigError';
}

function nodeEnv(env: NodeEnvironment): string | undefined {
  return env.NODE_ENV || undefined; // an empty NODE_ENV is a missing one
}

function known(name: string | undefined): name is NodeEnvironmentName {
  return name !== undefined && (NODE_ENVIRONMENTS as readonly string[]).includes(name);
}

export const environment = {
  /** `NODE_ENV` as set — `undefined` when it is missing (or empty), which is production. */
  name(env: NodeEnvironment = process.env): string | undefined {
    return nodeEnv(env);
  },

  /** `NODE_ENV=development`: the development tools run (E115) — and only here. */
  isDevelopment(env: NodeEnvironment = process.env): boolean {
    return nodeEnv(env) === 'development';
  },

  /** `NODE_ENV=test`: the test runner. Neither development tools nor protections. */
  isTest(env: NodeEnvironment = process.env): boolean {
    return nodeEnv(env) === 'test';
  },

  /**
   * Protections apply (E139): `production` — and, fail-closed, every `NODE_ENV` but `development` and `test`, a missing one too.
   * Check this on the protecting side, never `=== 'production'`. `APP_ENV` plays no part.
   */
  isProtected(env: NodeEnvironment = process.env): boolean {
    const name = nodeEnv(env);
    return name !== 'development' && name !== 'test';
  },

  /**
   * The app's environment (`APP_ENV`): its own name — `staging`, `production`, one of the app's — else the one that goes with
   * `NODE_ENV`: `local` (development), `testing` (test), `production` (production, or none). Shown, and it selects the scheduled
   * tasks (E221) — never ask it whether to protect something or to run a development tool.
   */
  app(env: NodeEnvironment = process.env): string {
    const own = env.APP_ENV || undefined; // an empty APP_ENV is a missing one
    if (own !== undefined) return own;
    const name = nodeEnv(env) ?? 'production';
    return known(name) ? APP_ENVIRONMENTS[name] : 'production';
  },

  /** Whether `NODE_ENV` was taken from the app's `.env` (E170) rather than set in the process's environment. */
  fromDotEnv(env: NodeEnvironment = process.env): boolean {
    const name = nodeEnv(env);
    return name !== undefined && env[DOTENV_MARKER] === name;
  },

  /**
   * The environment as a start line names it: `production (APP_ENV=staging)`, `development (APP_ENV=local)`,
   * `production (APP_ENV=production, NODE_ENV unset)` — and where `NODE_ENV` came from when that was `.env`:
   * `development (APP_ENV=local, NODE_ENV from .env)`. `app` is the app's `APP_ENV` as its configuration read it (it may live
   * in `.env`, which `process.env` does not see) — by default the one `env` has.
   */
  describe(env: NodeEnvironment = process.env, app: string = environment.app(env)): string {
    const name = nodeEnv(env);
    const notes = [`APP_ENV=${app}`, ...(name === undefined ? ['NODE_ENV unset'] : []), ...(environment.fromDotEnv(env) ? ['NODE_ENV from .env'] : [])];
    return `${name ?? 'production'} (${notes.join(', ')})`;
  },

  /**
   * What is wrong with `NODE_ENV` — `undefined` when it is `development`, `test`, `production` or missing. Any other value
   * stops the start ({@link environment.check}): a staging server is `NODE_ENV=production` with `APP_ENV=staging`.
   */
  problem(env: NodeEnvironment = process.env): string | undefined {
    const name = nodeEnv(env);
    if (name === undefined || known(name)) return undefined;
    const where = environment.fromDotEnv(env) ? ' (in .env)' : '';
    const docs = 'NODE_ENV is development, test or production; APP_ENV names the environment (docs/configuration.md#the-environment-node_env).';
    const lower = name.toLowerCase();
    if (known(lower)) return `NODE_ENV=${name}${where} is not an environment Node knows — it is case-sensitive: set NODE_ENV=${lower}.`;
    // A name worth repeating; anything else (a long or odd value) is not echoed.
    if (/^[A-Za-z0-9_.-]{1,40}$/.test(name)) return `NODE_ENV=${name}${where} is not an environment Node knows — set NODE_ENV=production and APP_ENV=${name}. ${docs}`;
    return `NODE_ENV${where} is not an environment Node knows — set NODE_ENV=production, and name the environment in APP_ENV. ${docs}`;
  },

  /**
   * Stops the start when `NODE_ENV` is none of `development`, `test`, `production` (a missing one is production): throws a
   * {@link ConfigError} with the hint. Called before anything asks {@link environment.isDevelopment} — by `marmeon` for every
   * command, by `createApplication` and by `startServer` — so an unknown value never reaches a development tool or a check.
   */
  check(env: NodeEnvironment = process.env): void {
    const problem = environment.problem(env);
    if (problem === undefined) return;
    const error = new ConfigError(`Invalid environment — the application cannot start:\n  • ${problem}`);
    error.stack = `${error.name}: ${error.message}`; // the location of the throw is noise here
    throw error;
  },

  /**
   * The warning a production command (`marmeon start`, `queue:work`, `schedule:work`) logs when it runs as `development`
   * because a `.env` says so (E170) — a developer's `.env` copied to a server turns the development tools on. Undefined otherwise.
   */
  dotEnvDevelopmentWarning(command: string, env: NodeEnvironment = process.env): string | undefined {
    if (!environment.isDevelopment(env) || !environment.fromDotEnv(env)) return undefined;
    return (
      `NODE_ENV=development comes from .env, not from the environment: marmeon ${command} runs with the development tools ` +
      '(error pages with source code, devtools, Vite) and without the production protections. On a server, set NODE_ENV=production ' +
      'in the environment — it wins over .env — and never deploy a development .env.'
    );
  },
} as const;

/**
 * `NODE_ENV` for `marmeon build`, once {@link resolveEnvironment} decided it (into `env`): what the build bakes into `dist/client`.
 * Vite builds the browser code with the process's `NODE_ENV` — anything but `production` keeps every development branch and
 * React's development build — so the build runs with `NODE_ENV=production` unless the environment itself says `development`:
 * a missing one, `test`, and a `NODE_ENV=development` **from `.env`** (a developer's, E170 — the commands of this machine) all
 * build for production. Set, not just removed: Vite reads the `.env` files itself and takes their `NODE_ENV=development`
 * whenever the process has none. A `NODE_ENV=development` set in the environment is respected, with a warning. Any other value
 * stops the build ({@link environment.check}). Returns the lines to print.
 */
export function buildEnvironment(env: Record<string, string | undefined> = process.env): { readonly notes: readonly string[]; readonly warnings: readonly string[] } {
  environment.check(env);
  if (environment.isDevelopment(env) && !environment.fromDotEnv(env)) {
    return {
      notes: [],
      warnings: [
        "marmeon build with NODE_ENV=development: the browser code keeps its development branches and React's development build — " +
          'error messages and stacks reach every visitor. Build without NODE_ENV (or with NODE_ENV=production) — marmeon dev is the development server (docs/deployment.md#configuration).',
      ],
    };
  }
  const name = nodeEnv(env);
  const fromDotEnv = environment.fromDotEnv(env);
  env.NODE_ENV = 'production';
  delete env[DOTENV_MARKER];
  if (name === 'development' && fromDotEnv) return { notes: ['NODE_ENV=development of .env is for the commands of this machine — marmeon build builds for production.'], warnings: [] };
  if (name === 'test') return { notes: ['marmeon build with NODE_ENV=test builds for production — the tests run the app without a build.'], warnings: [] };
  return { notes: [], warnings: [] };
}

export interface ResolvedEnvironment {
  /** The resolved `NODE_ENV` — `undefined`: none anywhere (production). */
  readonly name: string | undefined;
  /** `process`: set in the environment; `.env`: the app's `.env`; `fallback`: what the command sets without one; `unset`: none. */
  readonly source: 'process' | '.env' | 'fallback' | 'unset';
  /** What went wrong on the way (`.env.production` defining `NODE_ENV`) — each message once per process. */
  readonly warnings: readonly string[];
}

/** Messages already handed out — the CLI and `createApplication` both resolve; the first one reports. */
const reported = new Set<string>();

/** The variables of one env file — `{}` when there is none. */
export function readEnvFile(path: string): Record<string, string | undefined> {
  return existsSync(path) ? parseEnv(readFileSync(path, 'utf8')) : {};
}

/**
 * Resolves `NODE_ENV` for the app in `root` and writes it into `env` (`process.env`) — the one place that decides it (E170):
 * the process's own value wins; else the base `.env`'s (marked {@link DOTENV_MARKER}); else `fallback` (`marmeon start`:
 * `production`, `marmeon dev`: `development`); else none (production). A `.env.{NODE_ENV}` that sets `NODE_ENV` is ignored, with a
 * warning. A `NODE_ENV` that is none of `development`, `test`, `production` throws ({@link environment.check}) — the start error.
 */
export function resolveEnvironment(root: string, { fallback, env = process.env }: { fallback?: string; env?: Record<string, string | undefined> } = {}): ResolvedEnvironment {
  let source: ResolvedEnvironment['source'];
  const own = env.NODE_ENV || undefined;
  if (own !== undefined) {
    source = env[DOTENV_MARKER] === own ? '.env' : 'process';
    if (source === 'process') delete env[DOTENV_MARKER];
  } else {
    const fromFile = readEnvFile(join(root, '.env')).NODE_ENV || undefined;
    if (fromFile !== undefined) {
      env.NODE_ENV = fromFile;
      env[DOTENV_MARKER] = fromFile;
      source = '.env';
    } else if (fallback !== undefined) {
      env.NODE_ENV = fallback;
      delete env[DOTENV_MARKER];
      source = 'fallback';
    } else {
      delete env.NODE_ENV;
      delete env[DOTENV_MARKER];
      source = 'unset';
    }
  }
  // Nothing reads the environment before it is known to be one (E217): an unknown NODE_ENV stops here.
  environment.check(env);
  const name = env.NODE_ENV || undefined;
  const warnings: string[] = [];
  const overlay = name === undefined ? {} : readEnvFile(join(root, `.env.${name}`));
  // APP_ENV the same way, as `loadEnv` layers it — the process's, else `.env.{NODE_ENV}`'s, else `.env`'s — so every line that
  // names the environment (a worker's, `migrate`'s) says the name the configuration reads. Never a default: that is `app()`'s.
  if (!env.APP_ENV) {
    const named = overlay.APP_ENV || readEnvFile(join(root, '.env')).APP_ENV;
    if (named) env.APP_ENV = named;
  }
  if (name !== undefined) {
    const file = `.env.${name}`;
    const defined = overlay.NODE_ENV;
    const message = `NODE_ENV in ${file} is ignored: ${file} is chosen by NODE_ENV and cannot set it — set NODE_ENV in the environment or in .env.`;
    if (defined !== undefined && !reported.has(message)) {
      reported.add(message);
      warnings.push(message);
    }
  }
  return { name, source, warnings };
}
