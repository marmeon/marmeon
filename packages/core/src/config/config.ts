import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
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
 */
export function loadEnv(root: string, mode = process.env.NODE_ENV, environment: Env = process.env): Env {
  let fromFiles: Record<string, string | undefined> = {};
  for (const file of ['.env', mode ? `.env.${mode}` : undefined]) {
    const path = file && join(root, file);
    if (path && existsSync(path)) fromFiles = { ...fromFiles, ...parseEnv(readFileSync(path, 'utf8')) };
  }
  return { ...fromFiles, ...environment };
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
