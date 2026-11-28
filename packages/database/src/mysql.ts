import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isIP } from 'node:net';
import { MysqlDialect, type MysqlPool, type QueryCompiler } from 'kysely';
import { isoTimestamp } from './iso-timestamp.ts';
import { MarmeonMysqlCompiler } from './mysql-compiler.ts';
import { CastFailure, CONNECT_TIMEOUT_MS, guardedPool, MAX_PREPARED_STATEMENTS } from './mysql-session.ts';

export interface MysqlOptions {
  url: string;
  /** The connection's name, for the message when `mysql2` is missing and for a refused server (default `default`). */
  name?: string;
  /** Largest number of pooled connections (default 10). */
  poolMax?: number;
  /** How long opening a connection, or waiting for a free one, may take before it fails (default: the URL's `connect_timeout`, else {@link CONNECT_TIMEOUT_MS}). */
  connectTimeoutMs?: number;
  /** An idle pooled connection failed (the server restarted, an admin killed it); the pool replaces it. */
  onIdleError?: (error: Error) => void;
  /** What the server lists for each connection in `performance_schema.session_connect_attrs`, beside the driver's own. */
  connectAttributes?: Readonly<Record<string, string>>;
}

/** What to install for MySQL — an optional peer, with the tested major. */
export const MYSQL_INSTALL = 'pnpm add mysql2@^3';

type Mysql2 = typeof import('mysql2');
type Mysql2Field = Parameters<Extract<NonNullable<import('mysql2').PoolOptions['typeCast']>, (...parameters: never[]) => unknown>>[0];

/** The oldest `mysql2` the framework runs on: earlier ones have known flaws in authentication and compression handling. */
const MYSQL2_MINIMUM = [3, 24, 6] as const;

/** The installed `mysql2`'s version, from its package.json. Replaced in tests. */
const installedVersion = (): unknown => (createRequire(import.meta.url)('mysql2/package.json') as { version?: unknown }).version;

/**
 * Imports `mysql2`, or says how to install it — for `connection`: `DB_DRIVER=mysql` for `default`, the connection's name for any
 * other — and refuses any version but a 3.x from {@link MYSQL2_MINIMUM} on (an older one, another major, or one whose version is not `major.minor.patch`). Other failures
 * (a broken install) pass through. A module whose `TypedParameter` cannot be read (under plain Node it is on `default`) is refused too. `load` and `versionOf` are replaced in tests.
 */
export async function importMysql2(load: () => Promise<Mysql2> = () => import('mysql2'), connection = 'default', versionOf: () => unknown = installedVersion): Promise<Mysql2> {
  const who = connection === 'default' ? 'DB_DRIVER=mysql' : `The MySQL connection "${connection}"`;
  let module: Mysql2;
  try {
    module = await load();
  } catch (error) {
    const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
    if ((code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') && typeof message === 'string' && /['"]mysql2['"]/.test(message)) {
      throw new Error(`${who} needs the "mysql2" package, which is not installed in this app: ${MYSQL_INSTALL}`, { cause: error });
    }
    throw error;
  }
  const version = versionOf();
  const match = typeof version === 'string' ? /^(\d+)\.(\d+)\.(\d+)(?:[-+][\x21-\x7e]*)?$/.exec(version) : null;
  const found = match ? match.slice(1, 4).map(Number) : undefined;
  const old = found === undefined || found[0] !== MYSQL2_MINIMUM[0] || (found[0] === MYSQL2_MINIMUM[0] && (found[1]! < MYSQL2_MINIMUM[1] || (found[1] === MYSQL2_MINIMUM[1] && found[2]! < MYSQL2_MINIMUM[2])));
  if (old) {
    throw new Error(`${who} needs "mysql2" 3.x from ${MYSQL2_MINIMUM.join('.')} on, and this app has ${JSON.stringify(version)}: ${MYSQL_INSTALL}`);
  }
  // Under plain Node the CommonJS exports of mysql2 are on `default` (`TypedParameter` is a getter that the named exports do not see); bundlers differ.
  const exported = ((module as unknown as { default?: Mysql2 }).default ?? module) as Mysql2;
  if (typeof (exported.TypedParameter as { LONGLONG?: unknown } | undefined)?.LONGLONG !== 'function') {
    throw new Error(`${who} needs "mysql2" 3.x from ${MYSQL2_MINIMUM.join('.')} on, whose TypedParameter could not be read from the installed package: ${MYSQL_INSTALL}`);
  }
  return exported;
}

/** The query parameters of a MySQL URL that Marmeon passes on; any other is refused, so a URL cannot switch on `multipleStatements` or the client's flags. */
const PARAMETERS = ['ssl-mode', 'ssl-ca', 'ssl-cert', 'ssl-key', 'connect_timeout', 'socket'] as const;

/** The options of `mysql2` a URL could try to set, the ones a refusal may name. */
const MYSQL2_OPTIONS = [
  'multipleStatements', 'flags', 'charset', 'localInfile', 'infileStreamFactory', 'ssl', 'password', 'user', 'host', 'port', 'database', 'timezone',
  'typeCast', 'authPlugins', 'stringifyObjects', 'namedPlaceholders', 'rowsAsArray', 'nestTables', 'jsonStrings', 'dateStrings', 'supportBigNumbers',
  'bigNumberStrings', 'decimalNumbers', 'connectTimeout', 'socketPath', 'insecureAuth', 'debug', 'trace', 'compress', 'maxPreparedStatements',
];

/** MySQL's names for how much of the connection's TLS is checked. */
const SSL_MODES = ['DISABLED', 'REQUIRED', 'VERIFY_CA', 'VERIFY_IDENTITY'] as const;

const FILES = { 'ssl-ca': 'ca', 'ssl-cert': 'cert', 'ssl-key': 'key' } as const;

/** Largest `connect_timeout` in seconds a timer can wait (2^31 - 1 milliseconds). */
const MAX_CONNECT_TIMEOUT_SECONDS = 2_147_483;

/**
 * What `mysql2` is given for `url`, spelled out: the URL's parts, the TLS it asks for, and none of what a URL could otherwise switch on
 * (`mysql2` takes every query parameter as an option, `multipleStatements` and `flags` among them). `ssl-mode` is one of DISABLED,
 * REQUIRED (encrypted, not verified), VERIFY_CA and VERIFY_IDENTITY, with `ssl-ca`, `ssl-cert` and `ssl-key` as file paths; without it the
 * connection is not encrypted. Throws a `TypeError` for any other parameter, never quoting a value (it may be a password). The
 * connect timeout is `override`, else `connect_timeout` (seconds) of the URL, else {@link CONNECT_TIMEOUT_MS}.
 *
 * Values come back as on the other drivers: `bigint` columns as numbers (see `typeCast`), dates and times as text.
 */
export function mysqlConnection(url: string, override?: number): import('mysql2').PoolOptions & { connectTimeout: number } {
  const parsed = URL.parse(url);
  if (parsed === null || parsed.protocol !== 'mysql:' || parsed.hostname === '') throw new TypeError('The MySQL connection needs a mysql:// URL with a host.');
  const given = new Map<string, string>();
  for (const key of new Set(parsed.searchParams.keys())) {
    if (!(PARAMETERS as readonly string[]).includes(key)) {
      // A name is only quoted when it is one of mysql2's options: a URL whose `?` begins a password has no parameter names to quote.
      const named = MYSQL2_OPTIONS.includes(key) ? ` ${JSON.stringify(key)}` : '';
      throw new TypeError(`The URL of a MySQL connection has a query parameter${named} that Marmeon does not pass on; it takes ${PARAMETERS.join(', ')}.`);
    }
    const values = parsed.searchParams.getAll(key);
    if (values.length > 1) throw new TypeError(`The URL of a MySQL connection names ${key} more than once.`);
    given.set(key, values[0]!);
  }
  const seconds = given.get('connect_timeout');
  if (seconds !== undefined && !(/^\d+$/.test(seconds) && Number(seconds) <= MAX_CONNECT_TIMEOUT_SECONDS)) {
    throw new TypeError('The connect_timeout in the URL of a MySQL connection is not whole seconds from 0 to 2147483.');
  }
  const mode = given.get('ssl-mode')?.toUpperCase();
  if (mode !== undefined && !(SSL_MODES as readonly string[]).includes(mode)) {
    throw new TypeError(`The ssl-mode in the URL of a MySQL connection is one of ${SSL_MODES.join(', ')}.`);
  }
  // The host as mysql2 gets it: decoded (`127%2E0%2E0%2E1` is an address).
  const named = decodeURIComponent(parsed.hostname.startsWith('[') ? parsed.hostname.slice(1, -1) : parsed.hostname);
  // `mysql2` looks no name up for an address, so there is nothing to check a certificate's name against.
  if (mode === 'VERIFY_IDENTITY' && isIP(named) !== 0) {
    throw new TypeError("The URL of a MySQL connection has ssl-mode=VERIFY_IDENTITY with an IP address as its host: use the server's name, or VERIFY_CA.");
  }
  const files = Object.keys(FILES).filter((key) => given.has(key));
  if (files.length > 0 && (mode === undefined || mode === 'DISABLED')) {
    throw new TypeError(`The URL of a MySQL connection has ${files.join(', ')} but no ssl-mode that uses it: set ssl-mode to REQUIRED, VERIFY_CA or VERIFY_IDENTITY.`);
  }
  const host = parsed.hostname.startsWith('[') ? parsed.hostname.slice(1, -1) : parsed.hostname;
  return {
    host: decodeURIComponent(host),
    port: parsed.port === '' ? 3306 : Number(parsed.port),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: decodeURIComponent(parsed.pathname.slice(1)),
    ...(given.has('socket') ? { socketPath: given.get('socket')! } : {}),
    ...(mode === undefined || mode === 'DISABLED' ? {} : { ssl: tls(mode, given) }),
    connectTimeout: override ?? (seconds === undefined ? CONNECT_TIMEOUT_MS : Number(seconds) * 1000),
    charset: 'utf8mb4',
    // One statement per query: the server refuses a second statement in the text (a statement with parameters is prepared, which allows one anyway).
    multipleStatements: false,
    // `LOAD DATA LOCAL INFILE` lets a server read files of the app's host. mysql2 sets FOUND_ROWS by default, which makes an update's
    // affected rows the rows it matched, changed or not; `update()` counts on it, so this line pins it.
    flags: ['-LOCAL_FILES', 'FOUND_ROWS'],
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true,
    decimalNumbers: false,
    typeCast,
  };
}

function tls(mode: string, given: ReadonlyMap<string, string>): import('mysql2').SslOptions {
  const ssl: Record<string, unknown> = { minVersion: 'TLSv1.2', rejectUnauthorized: mode !== 'REQUIRED' };
  // Only VERIFY_IDENTITY checks the host name; `mysql2` reads this flag, not `checkServerIdentity`.
  ssl.verifyIdentity = mode === 'VERIFY_IDENTITY';
  for (const [key, option] of Object.entries(FILES)) {
    const path = given.get(key);
    if (path === undefined) continue;
    try {
      ssl[option] = readFileSync(path);
    } catch (error) {
      // The path stays out of the message, as with a Postgres key file.
      throw new TypeError(`The file named by ${key} in the URL of a MySQL connection could not be read (${(error as { code?: string }).code ?? 'error'}).`);
    }
  }
  return ssl as import('mysql2').SslOptions;
}

/**
 * Kysely's `MysqlDialect` on `mysql2` — an optional peer, imported on first use, so apps on the other drivers do not need it installed.
 * Every connection is checked and set up before it is used ({@link guardedPool}). Values come back as the same JavaScript types as on
 * SQLite and Postgres:
 *
 * - `tinyint(1)` (what `boolean` is) → `boolean`.
 * - `bigint` → `number`. IDs beyond 2^53 throw instead of rounding (a `RangeError`, once the whole result has been read).
 * - `float` → the number with 6 significant digits, as the text protocol has it (1.1, not 1.100000023841858), `time` → text without trailing zeros of the fraction.
 * - `datetime` and `timestamp` → ISO-8601 string in UTC (`2026-10-01T12:00:00.000Z`); the session runs in UTC.
 * - `date` → `YYYY-MM-DD` as stored. `decimal` → text, as `numeric` is on Postgres. `json` → parsed.
 */
export function createMysqlDialect(options: MysqlOptions): MysqlDialect {
  return new (class extends MysqlDialect {
    override createQueryCompiler(): QueryCompiler {
      return new MarmeonMysqlCompiler();
    }
  })({
    pool: () => mysqlPool(options),
  });
}

/** The guarded pool of `mysql2` for `options`: what {@link createMysqlDialect} uses, and the migration lock for a connection of its own. */
export async function mysqlPool(options: MysqlOptions): Promise<MysqlPool> {
  const mysql2 = await importMysql2(undefined, options.name);
  const config = mysqlConnection(options.url, options.connectTimeoutMs);
  const poolMax = options.poolMax ?? 10;
  const pool = mysql2.createPool({
    ...config,
    queryFormat: textOnly,
    connectionLimit: poolMax,
    // The guard holds the callers that wait for a connection, so a caller that timed out leaves nothing behind in the queue of `mysql2`;
    // it asks for a connection only when one is free or there is room for one. If that ever failed, this says so instead of queueing.
    waitForConnections: false,
    // A lease holds at most this many prepared statements (poolMax times it per process, none between leases): the reset of the way back
    // closes them all. `mysql2` evicts the least recently used one beyond it.
    maxPreparedStatements: MAX_PREPARED_STATEMENTS,
    // The guard resets a connection itself on the way back, and sets the session up again after it: a reset of `mysql2` behind ours would
    // take that set-up away.
    resetOnRelease: false,
    ...(options.connectAttributes ? { connectAttributes: { ...options.connectAttributes } } : {}),
  });
  return guardedPool(pool as unknown as MysqlPool, {
    poolMax,
    integer: (value, unsigned) => (unsigned ? mysql2.TypedParameter.LONGLONG.unsigned(value) : mysql2.TypedParameter.LONGLONG(value)),
    ...(options.name === undefined ? {} : { name: options.name }),
    connectTimeoutMs: config.connectTimeout,
    ...(options.onIdleError ? { onIdleError: options.onIdleError } : {}),
  });
}

/**
 * What `mysql2` runs through its text protocol, which formats the parameters into the statement. Marmeon sends no value that way: a
 * statement with parameters is prepared on the server (see {@link guardedPool}). This formatter returns the text of a statement without
 * parameters and throws for anything else, so a later change cannot route a value into the text.
 */
export const textOnly = (sql: string, values: unknown): string => {
  if (values === undefined || (Array.isArray(values) && values.length === 0)) return sql;
  throw new TypeError('a value never goes into the text of a MySQL statement');
};

/**
 * How `mysql2` reads a column, the same from the text protocol (a statement without parameters) and the binary one (a prepared
 * statement): the types of the other drivers. A null stays null. A value that does not fit is not thrown: a throw in the middle of a
 * result would leave `mysql2` out of step with the server, so the cell holds a {@link CastFailure} that the guard reports once the
 * whole result has been read. Exported for the tests.
 */
export function typeCast(field: Mysql2Field, next: () => unknown): unknown {
  switch (field.type) {
    case 'TINY': {
      // `tinyint(1)` is how MySQL spells `boolean`.
      if (field.length !== 1) return next();
      const text = field.string();
      return text === null ? null : Number(text) !== 0;
    }
    case 'LONGLONG': {
      // `next()` and not `field.string()`: the binary protocol sends eight bytes, which only `next()` reads (as text, with `bigNumberStrings`).
      const text = next() as string | null;
      return text === null ? null : parseInt8(String(text));
    }
    case 'FLOAT': {
      // The binary protocol has the float32 as it is (1.1 is 1.100000023841858), the text protocol six significant digits.
      const value = next();
      return typeof value === 'number' ? sixDigits(value) : value;
    }
    case 'TIME': {
      // The text protocol pads the fraction to the column's precision (`12:00:00.250`), the binary one does not (`12:00:00.25`).
      const text = field.string();
      return text === null ? null : trimFraction(text);
    }
    case 'JSON': {
      // `mysql2` parses JSON itself, and with `supportBigNumbers` it turns an integer beyond 2^53 into a string; `JSON.parse` is what the other drivers do.
      // The text is read as UTF-8 bytes: `string()` would decode a JSON column with the charset of the protocol (`binary`), which mangles umlauts.
      const bytes = field.buffer();
      if (bytes === null) return null;
      try {
        return JSON.parse(bytes.toString('utf8'));
      } catch (error) {
        return new CastFailure(error as Error);
      }
    }
    case 'DATETIME':
    case 'TIMESTAMP': {
      const text = field.string();
      return text === null ? null : isoTimestamp(text);
    }
    case 'DATE':
    case 'NEWDECIMAL':
    case 'DECIMAL':
      return field.string();
    default:
      return next();
  }
}

/** `12:00:00.250` as `12:00:00.25`, and `12:00:00.000` as `12:00:00`: the fraction without its trailing zeros. */
function trimFraction(text: string): string {
  const dot = text.indexOf('.');
  if (dot === -1) return text;
  let end = text.length;
  while (end > dot + 1 && text[end - 1] === '0') end -= 1;
  return text.slice(0, end === dot + 1 ? dot : end);
}

/**
 * A float32 with the 6 significant digits MySQL's text protocol writes it with (`1.2345678` is `1.23457`, 2^24 + 1 is `16777200`), so
 * both protocols agree. MySQL rounds an exact tie to the even digit (`123456.5` is `123456`), where `toPrecision` rounds it up.
 */
function sixDigits(value: number): number {
  if (!Number.isFinite(value) || value === 0) return value;
  // 21 significant digits are far more than a float32 (24 bits) has apart from a tie: a seventh digit 5 followed by zeros is an exact tie.
  const digits = Math.abs(value).toPrecision(21).split('e')[0]!.replace('.', '').replace(/^0+/, '');
  const exponent = Math.abs(value).toExponential().split('e')[1]!;
  if (digits[6] === '5' && /^0*$/.test(digits.slice(7))) {
    const six = Number(digits.slice(0, 6));
    const even = six % 2 === 0 ? six : six + 1;
    return Math.sign(value) * Number(`${even}e${Number(exponent) - 5}`);
  }
  return Number(value.toPrecision(6));
}

function parseInt8(value: string): number | CastFailure {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) return new CastFailure(new RangeError(`bigint value ${value} does not fit a JavaScript number; cast it to text in the query.`));
  return number;
}
