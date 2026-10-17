import { defineConfig, env, type ConfigDefinition, type ConfigOf, type StandardSchemaV1, type InferOutput } from '@marmeon/core';

/**
 * Where a connection points. `sqlite`: a file (relative to the app root) or `:memory:`. `pgsql`: a URL, the size of its
 * pool, and the size of the small pool its infrastructure (the cache, sessions — `connections.infrastructure()`)
 * opens on first use.
 */
export type ConnectionOptions =
  | { readonly driver: 'sqlite'; readonly database: string }
  | { readonly driver: 'pgsql'; readonly url: string; readonly poolMax?: number; readonly infrastructurePoolMax?: number };

/**
 * A Postgres connection as a definition's `resolve` returns it: the server and the account in parts, or the whole address in
 * `url` — the same two ways as the default connection's variables. When `url` is set, the parts are not read. Without it, the
 * parts make the URL: `host` (default `127.0.0.1`), `port` (`5432`), `database` (required), `username` (`postgres`) and
 * `password` (none).
 */
export interface PostgresConnection {
  readonly driver: 'pgsql';
  readonly url?: string | undefined;
  readonly host?: string | undefined;
  readonly port?: number | undefined;
  readonly database?: string | undefined;
  readonly username?: string | undefined;
  readonly password?: string | undefined;
  /** The most connections of its pool (default 10). */
  readonly poolMax?: number | undefined;
  /** The most connections of its infrastructure's own pool (default 4). */
  readonly infrastructurePoolMax?: number | undefined;
}

/** What a connection's `resolve` returns: a SQLite file, or a Postgres server in parts or as a URL ({@link PostgresConnection}). */
export type ConnectionDefinitionOptions = { readonly driver: 'sqlite'; readonly database: string } | PostgresConnection;

/** `options` as the connections use them: a Postgres server's parts made into its URL, unless the URL is given. */
function connectionOptions(name: string, options: ConnectionDefinitionOptions): ConnectionOptions {
  if (options.driver === 'sqlite') return options;
  const pools = {
    ...(options.poolMax === undefined ? {} : { poolMax: options.poolMax }),
    ...(options.infrastructurePoolMax === undefined ? {} : { infrastructurePoolMax: options.infrastructurePoolMax }),
  };
  if (options.url !== undefined) return { driver: 'pgsql', url: new URL(options.url).href, ...pools };
  if (options.database === undefined) throw new TypeError(`The Postgres connection "${name}" needs a url or a database.`);
  const url = new URL(`postgres://${options.host ?? '127.0.0.1'}:${options.port ?? 5432}`);
  url.username = options.username ?? 'postgres';
  url.password = options.password ?? '';
  url.pathname = `/${options.database}`;
  return { driver: 'pgsql', url: url.href, ...pools };
}

/** Connections of the infrastructure pool of a Postgres connection, unless it says otherwise. */
export const DEFAULT_INFRASTRUCTURE_POOL_MAX = 4;

/**
 * The default connection, from the environment: `DB_CONNECTION` (`sqlite` by default, or `pgsql`), the server and the account
 * in parts (`DB_HOST`, `DB_PORT`, `DB_DATABASE`, `DB_USERNAME`, `DB_PASSWORD`) or the whole address in `DB_URL`, which wins.
 * See `docs/database.md#configuration`.
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
    /** Postgres: largest number of connections of the infrastructure's own pool (cache, rate limits, locks, sessions). */
    DB_INFRA_POOL_MAX: env.integer().min(1).default(DEFAULT_INFRASTRUCTURE_POOL_MAX),
  }),
  resolve: (e): { default: ConnectionOptions } => {
    if (e.DB_CONNECTION === 'sqlite') return { default: { driver: 'sqlite', database: e.DB_DATABASE ?? 'storage/database.sqlite' } };
    return {
      default: connectionOptions('default', {
        driver: 'pgsql',
        url: e.DB_URL,
        host: e.DB_HOST,
        port: e.DB_PORT,
        database: e.DB_DATABASE ?? 'marmeon',
        username: e.DB_USERNAME,
        password: e.DB_PASSWORD,
        poolMax: e.DB_POOL_MAX,
        infrastructurePoolMax: e.DB_INFRA_POOL_MAX,
      }),
    };
  },
});
export type DatabaseConfig = ConfigOf<typeof DatabaseConfig>;

/** A named connection besides the default: a config definition that knows its name. */
export interface ConnectionDefinition extends ConfigDefinition<ConnectionOptions> {
  readonly connection: string;
}

/**
 * Another connection, e.g. a reporting database: list it in the app's (or a module's) `config` and get it with
 * `connections.get(name)`. A Postgres connection takes the server and the account in parts or one URL
 * ({@link PostgresConnection}) — the URL wins when both are given. See `docs/database.md#more-connections`.
 */
export function defineConnection<const Schema extends StandardSchemaV1>(
  name: string,
  definition: { env: Schema; resolve: (env: InferOutput<Schema>) => ConnectionDefinitionOptions },
): ConnectionDefinition {
  if (name === 'default') throw new TypeError('"default" is the connection from DB_CONNECTION; give this one another name.');
  return Object.freeze({ ...defineConfig(`database.${name}`, { env: definition.env, resolve: (e: InferOutput<Schema>) => connectionOptions(name, definition.resolve(e)) }), connection: name });
}

export function isConnectionDefinition(value: unknown): value is ConnectionDefinition {
  return typeof (value as Partial<ConnectionDefinition> | undefined)?.connection === 'string';
}

const SHOWN_PARAMETERS = new Set(['host', 'port', 'sslmode', 'application_name']);

/** For messages and `db:show`: where a connection points — host, port and database, the user, the password masked, of the query string only `host`, `port`, `sslmode` and `application_name`. */
export function describeConnection(options: ConnectionOptions): string {
  if (options.driver === 'sqlite') return `sqlite ${options.database}`;
  const url = new URL(options.url);
  if (url.password) url.password = '***';
  // The query string may carry the password again (`?password=…`) or a key path: only the parameters that say where the
  // server is stay (a socket connection is `?host=/var/run/postgresql`).
  for (const name of [...url.searchParams.keys()]) if (!SHOWN_PARAMETERS.has(name)) url.searchParams.delete(name);
  url.hash = '';
  return `pgsql ${url.href}`;
}
