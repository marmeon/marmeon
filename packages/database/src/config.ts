import { defineConfig, env, type ConfigDefinition, type ConfigOf, type StandardSchemaV1, type InferOutput } from '@marmeon/core';
import { maskUrlPasswords } from '@marmeon/core/internal';

/**
 * Where a connection points. `sqlite`: a file (relative to the app root) or `:memory:`. `pgsql`: a URL, the size of its
 * pool, and the size of the small pool its infrastructure (the cache, sessions — `connections.infrastructure()`)
 * opens on first use.
 */
export type ConnectionOptions =
  | { readonly driver: 'sqlite'; readonly database: string; readonly managed?: boolean }
  | { readonly driver: 'pgsql'; readonly url: string; readonly poolMax?: number; readonly infrastructurePoolMax?: number; readonly managed?: boolean };

/**
 * A Postgres connection as a definition's `resolve` returns it: the server and the account in parts, or the whole address in
 * `url` — the same two ways as the default connection's variables. When `url` is set, the parts are not read. Without it, the
 * parts make the URL: `host` (default `127.0.0.1`), `port` (`5432`), `database` (required), `username` (`postgres`) and
 * `password` (none).
 */
export interface PostgresConnectionOptions {
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
  /** `false`: another tool manages this database, not Marmeon's migrations (default `true`). See {@link ConnectionDefinitionOptions}. */
  readonly managed?: boolean | undefined;
}

/**
 * What a connection's `resolve` returns: a SQLite file, or a Postgres server in parts or as a URL ({@link PostgresConnectionOptions}).
 * `managed: false` says that another tool owns the database's tables: Marmeon takes no schema from migrations for it (no secret columns, no
 * soft deletes, no timestamps), `marmeon migrate` does not touch it, and its queries are not refused for pending migrations. The default is
 * `true`. See `docs/database.md#a-database-another-tool-manages`.
 */
export type ConnectionDefinitionOptions = { readonly driver: 'sqlite'; readonly database: string; readonly managed?: boolean | undefined } | PostgresConnectionOptions;

/** Whether a Postgres URL names a database: without one `pg` reads `PGDATABASE`, then the user name — a default shared between apps. */
function hasDatabaseName(url: string): boolean {
  try {
    return new URL(url).pathname.length > 1;
  } catch {
    return false;
  }
}

/** Whether the `connect_timeout` of a Postgres URL, if it has one, is whole seconds that a timer can wait: 0 (no limit) to 2147483. */
function hasValidConnectTimeout(url: string): boolean {
  const value = URL.parse(url)?.searchParams.get('connect_timeout');
  return value == null || (/^\d+$/.test(value) && Number(value) <= 2_147_483);
}

/** `options` as the connections use them: a Postgres server's parts made into its URL, unless the URL is given. */
function connectionOptions(name: string, options: ConnectionDefinitionOptions): ConnectionOptions {
  const managed = options.managed === false ? { managed: false } : {};
  if (options.driver === 'sqlite') return { driver: 'sqlite', database: options.database, ...managed };
  const pools = {
    ...managed,
    ...(options.poolMax === undefined ? {} : { poolMax: options.poolMax }),
    ...(options.infrastructurePoolMax === undefined ? {} : { infrastructurePoolMax: options.infrastructurePoolMax }),
  };
  if (options.url !== undefined) {
    if (!hasDatabaseName(options.url)) throw new TypeError(`The Postgres connection "${name}" needs a database: the name in its url's path, or database.`);
    if (!hasValidConnectTimeout(options.url)) throw new TypeError(`The Postgres connection "${name}" has a connect_timeout in its url that is not whole seconds from 0 to 2147483.`);
    return { driver: 'pgsql', url: new URL(options.url).href, ...pools };
  }
  if (!options.database) throw new TypeError(`The Postgres connection "${name}" needs a url or a database.`);
  const host = options.host ?? '127.0.0.1';
  // A socket directory travels as the `host` parameter (the authority stays: it carries the account); an IPv6 address needs brackets.
  const socket = host.startsWith('/');
  const authority = socket ? 'localhost' : host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  const url = new URL(`postgres://${authority}:${options.port ?? 5432}`);
  if (socket) url.searchParams.set('host', host);
  // Encoded here: the setters leave a `%` alone, and pg decodes what it reads, so `100%` or `%41` would arrive as another text.
  url.username = encodeURIComponent(options.username ?? 'postgres');
  url.password = encodeURIComponent(options.password ?? '');
  url.pathname = `/${options.database}`;
  return { driver: 'pgsql', url: url.href, ...pools };
}

/** Connections of the infrastructure pool of a Postgres connection, unless it says otherwise. */
export const DEFAULT_INFRASTRUCTURE_POOL_MAX = 4;

/**
 * The default connection, from the environment: `DB_DRIVER` (`sqlite` by default, or `pgsql`), the server and the account
 * in parts (`DB_HOST`, `DB_PORT`, `DB_DATABASE`, `DB_USERNAME`, `DB_PASSWORD`) or the whole address in `DB_URL`, which wins.
 * See `docs/database.md#configuration`.
 */
export const DatabaseConfig = defineConfig('database', {
  env: env({
    DB_DRIVER: env.in(['sqlite', 'pgsql']).default('sqlite'),
    DB_DATABASE: env.string().optional(),
    DB_URL: env.url({ protocols: ['postgres', 'postgresql'], message: 'Expected a postgres:// URL' }).optional(),
    DB_HOST: env.string().default('127.0.0.1'),
    DB_PORT: env.port().default(5432),
    DB_USERNAME: env.string().default('postgres'),
    DB_PASSWORD: env.string().default(''),
    /** Largest number of pooled Postgres connections. */
    DB_POOL_MAX: env.integer().min(1).default(10),
    /** Postgres: largest number of connections of the infrastructure's own pool (cache, rate limits, locks, sessions, uploads). */
    DB_INFRA_POOL_MAX: env.integer().min(1).default(DEFAULT_INFRASTRUCTURE_POOL_MAX),
    /** `false`: another tool manages the database, so Marmeon neither migrates it nor takes a schema from migrations for it. */
    DB_MANAGED: env.boolean().default(true),
  })
    .renamed('DB_CONNECTION', 'DB_DRIVER')
    .check(
      (e) => e.DB_DRIVER !== 'pgsql' || (e.DB_URL !== undefined ? hasDatabaseName(e.DB_URL) : e.DB_DATABASE !== undefined),
      'set DB_DATABASE, or DB_URL with the database\'s name in its path — apps on one Postgres server share their tables otherwise (docs/database.md#configuration)',
      'DB_DATABASE',
    )
    .check(
      (e) => e.DB_DRIVER !== 'pgsql' || e.DB_URL !== undefined || e.DB_DATABASE !== ':memory:',
      "DB_DATABASE=:memory: is SQLite's — set DB_DATABASE (or DB_URL) to the Postgres database's name; a starter's .env.test sets it (docs/installation.md#the-database)",
      'DB_DATABASE',
    )
    .check(
      (e) => e.DB_DRIVER !== 'pgsql' || e.DB_URL === undefined || hasValidConnectTimeout(e.DB_URL),
      'connect_timeout in DB_URL is whole seconds from 0 (no limit) to 2147483 (docs/database.md#configuration)',
      'DB_URL',
    ),
  resolve: (e): { default: ConnectionOptions } => {
    if (e.DB_DRIVER === 'sqlite') return { default: connectionOptions('default', { driver: 'sqlite', database: e.DB_DATABASE ?? 'storage/database.sqlite', managed: e.DB_MANAGED }) };
    return {
      default: connectionOptions('default', {
        driver: 'pgsql',
        url: e.DB_URL,
        host: e.DB_HOST,
        port: e.DB_PORT,
        database: e.DB_DATABASE,
        username: e.DB_USERNAME,
        password: e.DB_PASSWORD,
        poolMax: e.DB_POOL_MAX,
        infrastructurePoolMax: e.DB_INFRA_POOL_MAX,
        managed: e.DB_MANAGED,
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
 * ({@link PostgresConnectionOptions}) — the URL wins when both are given. See `docs/database.md#more-connections`.
 */
export function defineConnection<const Schema extends StandardSchemaV1>(
  name: string,
  definition: { env: Schema; resolve: (env: InferOutput<Schema>) => ConnectionDefinitionOptions },
): ConnectionDefinition {
  if (name === 'default') throw new TypeError('"default" is the connection from DB_DRIVER; give this one another name.');
  return Object.freeze({ ...defineConfig(`database.${name}`, { env: definition.env, resolve: (e: InferOutput<Schema>) => connectionOptions(name, definition.resolve(e)) }), connection: name });
}

export function isConnectionDefinition(value: unknown): value is ConnectionDefinition {
  return typeof (value as Partial<ConnectionDefinition> | undefined)?.connection === 'string';
}

const SHOWN_PARAMETERS = new Set(['host', 'port', 'sslmode', 'application_name']);

/** For messages and `db:show`: where a connection points — host, port and database, the user, the password masked, of the query string only `host`, `port`, `sslmode` and `application_name`. */
export function describeConnection(options: ConnectionOptions): string {
  if (options.driver === 'sqlite') return `sqlite ${options.database}`;
  // A password with a raw `/` can leave no URL at all; the text is not quoted then (the parser's error carries it).
  const url = URL.parse(options.url);
  if (url === null) return 'pgsql (invalid URL)';
  if (url.password) url.password = '***';
  // The query string may carry the password again (`?password=…`) or a key path: only the parameters that say where the
  // server is stay (a socket connection is `?host=/var/run/postgresql`).
  for (const name of [...url.searchParams.keys()]) if (!SHOWN_PARAMETERS.has(name)) url.searchParams.delete(name);
  url.hash = '';
  // A password with a raw `/` or `@` ends the userinfo early: what the parser took for the path still holds a rest of it.
  return `pgsql ${maskUrlPasswords(url.href)}`;
}
