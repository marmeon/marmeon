import { defineConfig, type ConfigDefinition, type ConfigOf, type StandardSchemaV1, type InferOutput } from '@marmeon/core';
import { rules as r } from '@marmeon/validation';

/**
 * Where a connection points. `sqlite`: a file (relative to the app root) or `:memory:`. `pgsql`: a URL, the size of its
 * pool, and the size of the small pool its infrastructure (the cache, sessions — `connections.infrastructure()`, E108)
 * opens on first use.
 */
export type ConnectionOptions =
  | { readonly driver: 'sqlite'; readonly database: string }
  | { readonly driver: 'pgsql'; readonly url: string; readonly poolMax?: number; readonly infrastructurePoolMax?: number };

/** Connections of the infrastructure pool of a Postgres connection, unless it says otherwise. */
export const DEFAULT_INFRASTRUCTURE_POOL_MAX = 4;

/**
 * The default connection, from the environment — the same variables as Laravel:
 *
 * ```sh
 * DB_CONNECTION=sqlite                   # sqlite (default) | pgsql
 * DB_DATABASE=storage/database.sqlite    # SQLite file, or the Postgres database name
 * DB_URL=postgres://user:secret@localhost:5432/app   # pgsql: a URL, or DB_HOST/DB_PORT/DB_USERNAME/DB_PASSWORD
 * DB_POOL_MAX=10                         # pgsql: the pool
 * DB_INFRA_POOL_MAX=4                    # pgsql: the infrastructure's own pool (cache, sessions — E108)
 * ```
 */
export const DatabaseConfig = defineConfig('database', {
  env: r.env({
    DB_CONNECTION: r.in(['sqlite', 'pgsql']).default('sqlite'),
    DB_DATABASE: r.string().optional(),
    DB_URL: r.string().regex(/^postgres(ql)?:\/\//, 'Expected a postgres:// URL').url({ protocols: ['postgres', 'postgresql'] }).optional(),
    DB_HOST: r.string().default('127.0.0.1'),
    DB_PORT: r.port().default(5432),
    DB_USERNAME: r.string().default('postgres'),
    DB_PASSWORD: r.string().default(''),
    /** Largest number of pooled Postgres connections. */
    DB_POOL_MAX: r.integer().min(1).default(10),
    /** Postgres: largest number of connections of the infrastructure's own pool (cache, rate limits, locks, sessions — E108). */
    DB_INFRA_POOL_MAX: r.integer().min(1).default(DEFAULT_INFRASTRUCTURE_POOL_MAX),
  }),
  resolve: (env): { default: ConnectionOptions } => {
    if (env.DB_CONNECTION === 'sqlite') return { default: { driver: 'sqlite', database: env.DB_DATABASE ?? 'storage/database.sqlite' } };
    const url = new URL(env.DB_URL ?? `postgres://${env.DB_HOST}:${env.DB_PORT}`);
    if (!env.DB_URL) {
      url.username = env.DB_USERNAME;
      url.password = env.DB_PASSWORD;
      url.pathname = `/${env.DB_DATABASE ?? 'marmeon'}`;
    }
    return { default: { driver: 'pgsql', url: url.href, poolMax: env.DB_POOL_MAX, infrastructurePoolMax: env.DB_INFRA_POOL_MAX } };
  },
});
export type DatabaseConfig = ConfigOf<typeof DatabaseConfig>;

/** A named connection besides the default: a config definition that knows its name. */
export interface ConnectionDefinition extends ConfigDefinition<ConnectionOptions> {
  readonly connection: string;
}

/**
 * Another connection, e.g. a reporting database. List it with the app's (or a module's) `config`;
 * its variables are validated at startup like all configuration:
 *
 * ```ts
 * export const Reporting = defineConnection('reporting', {
 *   env: r.env({ REPORTING_DB_URL: r.url({ protocols: ['postgres', 'postgresql'] }) }),
 *   resolve: (env) => ({ driver: 'pgsql', url: env.REPORTING_DB_URL }),
 * });
 * defineApplication({ config: [Reporting], … });
 * connections.get('reporting')
 * ```
 */
export function defineConnection<const Schema extends StandardSchemaV1>(
  name: string,
  definition: { env: Schema; resolve: (env: InferOutput<Schema>) => ConnectionOptions },
): ConnectionDefinition {
  if (name === 'default') throw new TypeError('"default" is the connection from DB_CONNECTION; give this one another name.');
  return Object.freeze({ ...defineConfig(`database.${name}`, definition), connection: name });
}

export function isConnectionDefinition(value: unknown): value is ConnectionDefinition {
  return typeof (value as Partial<ConnectionDefinition> | undefined)?.connection === 'string';
}

/** For messages and `db:show`: where a connection points, with the password masked. */
export function describeConnection(options: ConnectionOptions): string {
  if (options.driver === 'sqlite') return `sqlite ${options.database}`;
  const url = new URL(options.url);
  if (url.password) url.password = '***';
  return `pgsql ${url.href}`;
}
