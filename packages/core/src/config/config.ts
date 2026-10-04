import { join } from 'node:path';
import { readEnvFile } from '../environment.ts';
import type { Token } from '../token.ts';
import { issuePath, type InferOutput, type StandardSchemaV1 } from './standard-schema.ts';

type Env = Readonly<Record<string, string | undefined>>;

/**
 * A validated, typed piece of configuration. It is also a container token, so
 * with a same-named type it is injected like any service:
 *
 * ```ts
 * export const AppConfig = defineConfig('app', {
 *   env: v.object({ APP_NAME: v.string(), PORT: v.optional(v.pipe(v.string(), v.transform(Number)), '3000') }),
 *   resolve: (env) => ({ name: env.APP_NAME, port: env.PORT }),
 * });
 * export type AppConfig = ConfigOf<typeof AppConfig>;
 *
 * class ShowLoginController { constructor(config: AppConfig) {} }
 * ```
 */
export interface ConfigDefinition<T> extends Token<T> {
  readonly env: StandardSchemaV1;
  readonly resolve: (env: any) => T;
}

export type ConfigOf<Definition> = Definition extends ConfigDefinition<infer T> ? T : never;

export function defineConfig<const Schema extends StandardSchemaV1, T>(
  name: string,
  definition: { env: Schema; resolve: (env: InferOutput<Schema>) => T },
): ConfigDefinition<T> {
  return Object.freeze({ key: Symbol(`config:${name}`), name, env: definition.env, resolve: definition.resolve });
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/**
 * Reads `.env`, then `.env.{mode}` on top (e.g. `.env.test`, like Laravel's
 * `.env.testing`); variables from the real environment win over both.
 * Parsed with `util.parseEnv`, so `process.env` itself is never modified.
 *
 * `NODE_ENV` follows the one resolution of `@bespokecore/core/environment` (E170): the real environment's, else the base
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
  const resolved = new Map<ConfigDefinition<unknown>, unknown>();
  const problems: string[] = [];

  for (const definition of definitions) {
    const result = await definition.env['~standard'].validate(env);
    if (result.issues) {
      for (const issue of result.issues) {
        const path = issuePath(issue);
        problems.push(`  • ${definition.name}: ${path ? `${path} — ` : ''}${issue.message}`);
      }
    } else {
      resolved.set(definition, definition.resolve(result.value));
    }
  }

  if (problems.length > 0) {
    const error = new ConfigError(
      `Invalid configuration — the application cannot start:\n${problems.join('\n')}\n` +
        'Set these variables in the environment or in .env (see .env.example).',
    );
    error.stack = `${error.name}: ${error.message}`; // the location of the throw is noise here
    throw error;
  }
  return resolved;
}
