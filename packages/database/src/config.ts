import { defineConfig, env, type ConfigDefinition, type ConfigOf, type StandardSchemaV1, type InferOutput } from '@marmeon/core';

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
  env: env({
    DB_CONNECTION: env.in(['sqlite', 'pgsql']).default('sqlite'),
    DB_DATABASE: env.string().optional(),
    DB_URL: env.url({ protocols: ['postgres', 'postgresql'], message: 'Expected a postgres:// URL' }).optional(),
    DB_HOST: env.string().default('127.0.0.1'),
    DB_PORT: env.port().default(5432),
    DB_USERNAME: env.string().default('postgres'),
    DB_PASSWORD: env.string().default(''),
    /** Largest number of pooled Postgres connections. */
    DB_POOL_MAX: env.integer().min(1).default(10),
    /** Postgres: largest number of connections of the infrastructure's own pool (cache, rate limits, locks, sessions — E108). */
    DB_INFRA_POOL_MAX: env.integer().min(1).default(DEFAULT_INFRASTRUCTURE_POOL_MAX),
  }),
  resolve: (e): { default: ConnectionOptions } => {
    if (e.DB_CONNECTION === 'sqlite') return { default: { driver: 'sqlite', database: e.DB_DATABASE ?? 'storage/database.sqlite' } };
    const url = new URL(e.DB_URL ?? `postgres://${e.DB_HOST}:${e.DB_PORT}`);
    if (!e.DB_URL) {
      url.username = e.DB_USERNAME;
      url.password = e.DB_PASSWORD;
      url.pathname = `/${e.DB_DATABASE ?? 'marmeon'}`;
    }
    return { default: { driver: 'pgsql', url: url.href, poolMax: e.DB_POOL_MAX, infrastructurePoolMax: e.DB_INFRA_POOL_MAX } };
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
 *   env: env({ REPORTING_DB_URL: env.url({ protocols: ['postgres', 'postgresql'] }) }),
 *   resolve: (e) => ({ driver: 'pgsql', url: e.REPORTING_DB_URL }),
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
