import { withCode } from '../error-codes.ts';
import { join } from 'node:path';
import { ConfigError, readEnvFile } from '../environment.ts';
import type { Token } from '../token.ts';
import { issuePath, type InferOutput, type StandardSchemaV1 } from './standard-schema.ts';

type Env = Readonly<Record<string, string | undefined>>;

/**
 * A validated, typed piece of configuration — also a container token, so with a same-named type
 * (`export type AppConfig = ConfigOf<typeof AppConfig>`) it is injected like any service.
 * See docs/configuration.md#defining-configuration.
 */
export interface ConfigDefinition<T> extends Token<T> {
  readonly env: StandardSchemaV1;
  readonly resolve: (env: any) => T;
}

export type ConfigOf<Definition> = Definition extends ConfigDefinition<infer T> ? T : never;

/**
 * Defines a validated, typed piece of configuration: `env` names the variables, `resolve` builds the value — a container
 * token, injected like any service. See docs/configuration.md#defining-configuration.
 */
export function defineConfig<const Schema extends StandardSchemaV1, T>(
  name: string,
  definition: { env: Schema; resolve: (env: InferOutput<Schema>) => T },
): ConfigDefinition<T> {
  return Object.freeze({ key: Symbol(`config:${name}`), name, env: definition.env, resolve: definition.resolve });
}

// The start's error lives beside `NODE_ENV`'s check (an unknown `NODE_ENV` fails with it too).
export { ConfigError };

/**
 * Reads `.env`, then `.env.{mode}` on top (e.g. `.env.test`); variables from the real environment win over both.
 * Parsed with `util.parseEnv`, so `process.env` itself is never modified.
 *
 * `NODE_ENV` follows the one resolution of `@marmeon/core/environment`: the real environment's, else the base
 * `.env`'s — which is also what picks `.env.{mode}` when `mode` is not given. `.env.{mode}` never sets `NODE_ENV`.
 */
export function loadEnv(root: string, mode?: string, environment: Env = process.env): Env {
  const base = readEnvFile(join(root, '.env'));
  const chosen = mode ?? (environment.NODE_ENV || base.NODE_ENV || undefined);
  const { NODE_ENV: _ignored, ...overlay } = chosen ? readEnvFile(join(root, `.env.${chosen}`)) : {};
  return { ...base, ...overlay, ...environment };
}

/**
 * Validates every definition against `env` and resolves it. Collects *all*
 * problems across all definitions before failing, so one start shows everything
 * that needs fixing instead of one variable at a time.
 */
export async function resolveConfig(
  definitions: readonly ConfigDefinition<unknown>[],
  env: Env,
): Promise<Map<ConfigDefinition<unknown>, unknown>> {
  const { resolved, problems } = await validateConfig(definitions, env);
  if (problems.size > 0) throw invalidConfiguration(problems);
  return resolved;
}

/**
 * Validates every definition against `env` without failing: the resolved values, and the problems of every definition that
 * did not validate (`  • name: VARIABLE — message` per issue). `createApplication` in the build phase binds the valid ones
 * and leaves the others unavailable — the build needs no runtime secrets.
 */
export async function validateConfig(
  definitions: readonly ConfigDefinition<unknown>[],
  env: Env,
): Promise<{ resolved: Map<ConfigDefinition<unknown>, unknown>; problems: Map<ConfigDefinition<unknown>, string[]> }> {
  const resolved = new Map<ConfigDefinition<unknown>, unknown>();
  const problems = new Map<ConfigDefinition<unknown>, string[]>();

  for (const definition of definitions) {
    const result = await definition.env['~standard'].validate(env);
    if (result.issues) {
      problems.set(
        definition,
        result.issues.map((issue) => {
          const path = issuePath(issue);
          return `  • ${definition.name}: ${path ? `${path} — ` : ''}${issue.message}`;
        }),
      );
    } else {
      resolved.set(definition, definition.resolve(result.value));
    }
  }
  return { resolved, problems };
}

/** The error a start fails with: every problem of every definition at once. */
export function invalidConfiguration(problems: ReadonlyMap<ConfigDefinition<unknown>, readonly string[]>): ConfigError {
  const error = new ConfigError(
    withCode(
      'K6',
      `Invalid configuration — the application cannot start:\n${[...problems.values()].flat().join('\n')}\n` +
        'Set these variables in the environment or in .env (see .env.example).',
    ),
  );
  error.stack = `${error.name}: ${error.message}`; // the location of the throw is noise here
  return error;
}
