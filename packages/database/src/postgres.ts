import { PostgresDialect } from 'kysely';

export interface PostgresOptions {
  url: string;
  /** The connection's name, for the message when `pg` is missing (default `default`, which `DB_DRIVER` configures). */
  name?: string;
  /** Largest number of pooled connections (default 10). */
  poolMax?: number;
  /** How long opening a connection, or waiting for a free one, may take before it fails (default: the URL's `connect_timeout`, else {@link CONNECT_TIMEOUT_MS}). */
  connectTimeoutMs?: number;
  /**
   * An idle pooled connection failed (the server restarted, an admin terminated it). Without a
   * listener, pg emits an unhandled 'error' event — which ends the Node process.
   */
  onIdleError?: (error: Error) => void;
}

/** How long a connection to Postgres may take to open: an unreachable host fails after it instead of hanging `migrate` and the readiness check. */
export const CONNECT_TIMEOUT_MS = 10_000;

const UTC_SESSION = '-c TimeZone=UTC';

/**
 * What `pg` is given for `url`. `pg` lets the URL's `options` replace the config's, so they are taken out of the URL and sent
 * as `options` with the UTC session after them. A bracketed IPv6 host goes to `pg` as the `host` parameter, because `pg`
 * would look the brackets up as part of a name. The connect timeout is `override`, else libpq's `connect_timeout` (seconds) of the
 * URL, else {@link CONNECT_TIMEOUT_MS}.
 */
export function postgresConnection(url: string, override?: number): { connectionString: string; options: string; connectionTimeoutMillis: number } {
  const parsed = URL.parse(url);
  if (parsed === null) return { connectionString: url, options: UTC_SESSION, connectionTimeoutMillis: override ?? CONNECT_TIMEOUT_MS };
  // The value was checked with the configuration: whole seconds, 0 for no limit.
  const seconds = parsed.searchParams.get('connect_timeout');
  const urlTimeout = seconds ? Number(seconds) * 1000 : undefined;
  const urlOptions = parsed.searchParams.get('options');
  let changed = false;
  if (urlOptions !== null) {
    parsed.searchParams.delete('options');
    changed = true;
  }
  if (parsed.hostname.startsWith('[') && !parsed.searchParams.has('host')) {
    parsed.searchParams.set('host', parsed.hostname.slice(1, -1));
    changed = true;
  }
  return {
    connectionString: changed ? parsed.href : url,
    options: [urlOptions?.trim(), UTC_SESSION].filter(Boolean).join(' '),
    connectionTimeoutMillis: override ?? urlTimeout ?? CONNECT_TIMEOUT_MS,
  };
}

// Postgres type OIDs whose default parsing differs from what SQLite returns.
const INT8 = 20;
const DATE = 1082;
const TIMESTAMP = 1114;
const TIMESTAMPTZ = 1184;

/**
 * Kysely's `PostgresDialect` on `pg` — an optional peer, imported on first use, so SQLite-only apps
 * do not need it installed. Values come back as the same JavaScript types as on SQLite:
 *
 * - `bigint`/`bigserial` → `number` (pg returns strings). IDs beyond 2^53 throw instead of rounding.
 * - `timestamp(tz)` → ISO-8601 string in UTC (`2026-10-01T12:00:00.000Z`), never a `Date`: inside a
 *   `jsonArrayFrom` relation Postgres returns text anyway, so a `Date` would only exist at the top level.
 * - `date` → `YYYY-MM-DD` as stored (pg would turn it into a local-midnight `Date`).
 *
 * The session runs in UTC, so timestamps without a time zone are read and written as UTC too.
 */
export function createPostgresDialect(options: PostgresOptions): PostgresDialect {
  return new PostgresDialect({
    pool: async () => {
      const pg = await importPg(undefined, options.name);
      const types = {
        getTypeParser: (oid: number, format?: 'text' | 'binary') => {
          if (oid === INT8) return parseInt8;
          if (oid === TIMESTAMPTZ || oid === TIMESTAMP) return toIsoTimestamp;
          if (oid === DATE) return (value: string) => value;
          return pg.types.getTypeParser(oid, format);
        },
      };
      const pool = new pg.Pool({
        ...postgresConnection(options.url, options.connectTimeoutMs),
        max: options.poolMax ?? 10,
        types,
      });
      // The pool replaces a broken idle connection by itself; it only needs to be told not to crash.
      pool.on('error', (error) => options.onIdleError?.(error));
      return pool;
    },
  });
}

/** What to install for Postgres — an optional peer (SQLite needs nothing, `pg` is one of the drivers), with the tested major. */
export const PG_INSTALL = 'pnpm add pg@^8';

/**
 * Imports `pg`, or says how to install it — for `connection`: `DB_DRIVER=pgsql` for `default`, the connection's name for any
 * other. Other failures (a broken install) pass through. `load` is replaced in tests.
 */
export async function importPg(load: () => Promise<{ default: unknown }> = () => import('pg'), connection = 'default'): Promise<(typeof import('pg'))['default']> {
  try {
    return (await load()).default as (typeof import('pg'))['default'];
  } catch (error) {
    const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
    if ((code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') && typeof message === 'string' && /['"]pg['"]/.test(message)) {
      const who = connection === 'default' ? 'DB_DRIVER=pgsql' : `The Postgres connection "${connection}"`;
      throw new Error(`${who} needs the "pg" package, which is not installed in this app: ${PG_INSTALL}`, { cause: error });
    }
    throw error;
  }
}

function parseInt8(value: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new RangeError(`bigint value ${value} does not fit a JavaScript number; cast it to text in the query.`);
  return number;
}

/** `2026-10-01 12:00:00.123456+00` (UTC session) → `2026-10-01T12:00:00.123Z`. */
function toIsoTimestamp(value: string): string {
  if (value === 'infinity' || value === '-infinity') return value;
  const match = /^(\d{4,}-\d\d-\d\d) (\d\d:\d\d:\d\d)(?:\.(\d+))?(?:\+00(?::?00)?)?( BC)?$/.exec(value);
  if (!match || match[4]) return new Date(value).toISOString();
  const [, date, time, fraction = ''] = match;
  return `${date}T${time}.${fraction.padEnd(3, '0').slice(0, 3)}Z`;
}
