/**
 * What `NODE_ENV` means to the framework — the one place that decides it (E115, E139), and where it comes from (E170).
 *
 * Two rules, and they are not mirror images of each other:
 * - **Development tools** (Vite's dev server, the error page's details, the devtools, `Server-Timing`, the mail previews,
 *   pretty logs, regenerated table types) run **only** with `NODE_ENV=development` — never with "anything but production".
 * - **Protections** (JSON logs, `migrate` asking for `--force`, the boot warnings, no lab pages) apply to **every**
 *   `NODE_ENV` except `development` and `test` — fail-closed: `staging`, `production`, a typo and a missing `NODE_ENV`
 *   are all protected.
 *
 * **Where it comes from** ({@link resolveEnvironment}, E170): the process's `NODE_ENV` — else the one in the app's `.env`
 * (only the base file: `.env.{NODE_ENV}` is chosen by it and cannot define it) — else none, which is protected (`marmeon start`
 * then sets `production`). The resolved value is written to `process.env.NODE_ENV` once, at the start of the process, so
 * config definitions, the CLI and the server all read the same one; a value taken from `.env` is marked as such and named
 * wherever the environment is shown (`development (from .env)`).
 *
 * Every function reads `process.env` unless given the environment a config definition resolves from (`env` of `defineConfig`).
 * This module has no dependencies besides Node: `marmeon` loads it (`@marmeon/core/environment`) before the injection hook.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

export interface NodeEnvironment {
  readonly NODE_ENV?: string | undefined;
  readonly [DOTENV_MARKER]?: string | undefined;
}

/** Set next to `NODE_ENV` when its value came from `.env` (holds that value, so a later explicit `NODE_ENV` is never mistaken). */
export const DOTENV_MARKER = 'MARMEON_NODE_ENV_FROM_DOTENV';

function nodeEnv(env: NodeEnvironment): string | undefined {
  return env.NODE_ENV || undefined; // an empty NODE_ENV is a missing one
}

export const environment = {
  /** `NODE_ENV` as set — `undefined` when it is missing (or empty). */
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
   * Protections apply (E139): every `NODE_ENV` but `development` and `test` — `production`, `staging`, anything else and a
   * missing one. Check this on the protecting side, never `=== 'production'`.
   */
  isProtected(env: NodeEnvironment = process.env): boolean {
    const name = nodeEnv(env);
    return name !== 'development' && name !== 'test';
  },

  /** Whether `NODE_ENV` was taken from the app's `.env` (E170) rather than set in the process's environment. */
  fromDotEnv(env: NodeEnvironment = process.env): boolean {
    const name = nodeEnv(env);
    return name !== undefined && env[DOTENV_MARKER] === name;
  },

  /**
   * The environment as a start line names it: `production (protected)`, `staging (protected)`, `development`, `test`,
   * `unset NODE_ENV (protected, like production)` — and where it came from when that was `.env`: `development (from .env)`.
   */
  describe(env: NodeEnvironment = process.env): string {
    const name = nodeEnv(env);
    if (name === undefined) return 'unset NODE_ENV (protected, like production)';
    const notes = [...(environment.isProtected(env) ? ['protected'] : []), ...(environment.fromDotEnv(env) ? ['from .env'] : [])];
    return notes.length > 0 ? `${name} (${notes.join(', ')})` : name;
  },

  /**
   * The warning a production command (`marmeon start`, `queue:work`, `schedule:work`) logs when it runs as `development`
   * because a `.env` says so (E170) — a developer's `.env` copied to a server turns the development tools on. Undefined otherwise.
   */
  dotEnvDevelopmentWarning(command: string, env: NodeEnvironment = process.env): string | undefined {
    if (!environment.isDevelopment(env) || !environment.fromDotEnv(env)) return undefined;
    return (
      `NODE_ENV=development comes from .env, not from the environment: marmeon ${command} runs with the development tools ` +
      '(error pages with source code, devtools, Vite) and without the production protections. On a server, set NODE_ENV ' +
      '(production, staging) in the environment — it wins over .env — and never deploy a development .env.'
    );
  },
} as const;

export interface ResolvedEnvironment {
  /** The resolved `NODE_ENV` — `undefined`: none anywhere (protected). */
  readonly name: string | undefined;
  /** `process`: set in the environment; `.env`: the app's `.env`; `fallback`: what the command sets without one; `unset`: none. */
  readonly source: 'process' | '.env' | 'fallback' | 'unset';
  /** What went wrong on the way (`.env.staging` defining `NODE_ENV`) — each message once per process. */
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
 * `production`, `marmeon dev`: `development`); else none. A `.env.{NODE_ENV}` that sets `NODE_ENV` is ignored, with a warning.
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
  const name = env.NODE_ENV || undefined;
  const warnings: string[] = [];
  if (name !== undefined) {
    const file = `.env.${name}`;
    const defined = readEnvFile(join(root, file)).NODE_ENV;
    const message = `NODE_ENV in ${file} is ignored: ${file} is chosen by NODE_ENV and cannot set it — set NODE_ENV in the environment or in .env.`;
    if (defined !== undefined && !reported.has(message)) {
      reported.add(message);
      warnings.push(message);
    }
  }
  return { name, source, warnings };
}
