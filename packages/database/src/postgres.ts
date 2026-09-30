import { PostgresDialect } from 'kysely';

export interface PostgresOptions {
  url: string;
  /** Largest number of pooled connections (default 10). */
  poolMax?: number;
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
      const pg = await importPg();
      const types = {
        getTypeParser: (oid: number, format?: 'text' | 'binary') => {
          if (oid === INT8) return parseInt8;
          if (oid === TIMESTAMPTZ || oid === TIMESTAMP) return toIsoTimestamp;
          if (oid === DATE) return (value: string) => value;
          return pg.types.getTypeParser(oid, format);
        },
      };
      return new pg.Pool({ connectionString: options.url, max: options.poolMax ?? 10, types, options: '-c TimeZone=UTC' });
    },
  });
}

async function importPg(): Promise<(typeof import('pg'))['default']> {
  try {
    return (await import('pg')).default;
  } catch (error) {
    throw new Error('DB_CONNECTION=pgsql needs the "pg" package: pnpm add pg', { cause: error });
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
