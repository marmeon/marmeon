import { CommandArgumentsError, environment, Redactor } from '@marmeon/core';
import { printable } from '@marmeon/core/internal';
import type { CommandInput } from 'marmeon';
import { Connections } from '../connections.ts';
import { Migrator } from '../migrations/migrator.ts';
import { readOnlyQuery } from '../read-only-query.ts';
import { factsOf } from '../schema/projection.ts';

/** The most SQL `--stdin` reads, in bytes. */
const MAX_SQL_BYTES = 64 * 1024;
const MAX_LIMIT = 1000;
const MAX_TIMEOUT_SECONDS = 60;
const USAGE = 'marmeon db:query [<sql>] [--stdin] [--database=<connection>] [--limit=<rows>] [--timeout=<seconds>] [--json]';

/**
 * Answers one read-only query as a table or a `--json` document. The database itself keeps the query read-only, on a connection
 * of its own and never through the app's pool, and the columns the migrations mark `secret()` are refused. Runs only with
 * `NODE_ENV` development or test. See docs/database.md#querying-a-connection.
 */
export class DbQueryCommand {
  static command = 'db:query';
  static description = 'Run one read-only query on a connection (development and test only)';
  static usage = '[<sql>] [--stdin] [--database=<connection>] [--limit=<rows>] [--timeout=<seconds>] [--json]';
  static options = {
    stdin: { type: 'boolean' },
    database: { type: 'string' },
    limit: { type: 'string' },
    timeout: { type: 'string' },
    json: { type: 'boolean' },
  } as const;

  readonly #connections: Connections;
  readonly #migrator: Pick<Migrator, 'readProjection' | 'ranProjection' | 'undescribedColumns'>;
  readonly #redactor: Redactor;

  /** @internal The container builds the command. */
  constructor(connections: Connections, migrator: Migrator, redactor: Redactor) {
    this.#connections = connections;
    this.#migrator = migrator;
    this.#redactor = redactor;
  }

  async handle({ args, options, output }: CommandInput): Promise<number> {
    const stdin = options.stdin === true;
    if (args.length > 1 || (args.length === 1) === stdin) throw new CommandArgumentsError(`Pass the SQL as one argument or with --stdin, not both and not neither: ${USAGE}`);
    const limit = wholeNumber('--limit', options.limit, 100, MAX_LIMIT);
    const timeout = wholeNumber('--timeout', options.timeout, 10, MAX_TIMEOUT_SECONDS);
    if (options.database !== undefined && (typeof options.database !== 'string' || options.database === '')) throw new CommandArgumentsError(`--database takes one connection name: ${USAGE}`);
    if (stdin && process.stdin.isTTY) throw new CommandArgumentsError(`--stdin reads a pipe, not a terminal: ${USAGE}`);

    // Checked positively: an unset or unknown NODE_ENV is not a development database.
    if (!environment.isDevelopment() && !environment.isTest()) {
      output.error(`db:query runs only in development and test, not with NODE_ENV=${environment.describe()}.`);
      return 1;
    }

    const sql = stdin ? await readStdin() : args[0]!;
    if (sql.trim() === '') throw new CommandArgumentsError(`The SQL is empty: ${USAGE}`);

    const name = typeof options.database === 'string' ? options.database : 'default';
    let driver: string;
    let secrets: Map<string, Set<string>>;
    let undescribed = new Map<string, Set<string>>();
    let withheld = new Set<string>();
    try {
      const connection = this.#connections.options(name);
      driver = connection.driver;
      secrets = new Map();
      if (connection.managed !== false) ({ secrets, undescribed, withheld } = await this.#secrets(name, connection.driver));
    } catch (error) {
      output.error(this.#redactor.text(error instanceof Error ? error.message : String(error)));
      return 1;
    }

    const result = await readOnlyQuery(this.#connections, name, sql, { limit, secrets, withheld, redact: (text) => this.#redactor.text(text), timeoutMs: timeout * 1000 });
    if (!result.ok) {
      const message = result.error.message;
      const lower = message.toLowerCase();
      const unknown = [...withheld].some((table) => lower.includes(table.toLowerCase())) || [...undescribed].some(([table, columns]) => [...columns].some((column) => lower.includes(`${table}.${column}`.toLowerCase())));
      output.error(this.#redactor.text(unknown ? `${message} No migration describes it (a table made by raw SQL or another tool): create it with schema.create() to read it, or run marmeon migrate if a migration is pending.` : message));
      return 1;
    }
    const { columns, rows, truncated, cut } = result.value;

    if (options.json === true) {
      output.json({ format: 1, connection: name, driver, columns, rows, truncated, cut, warnings: [] });
      return 0;
    }
    output.table(
      columns.map((column) => printable(column.name)),
      rows.map((row) => row.map(cellText)),
    );
    output.line();
    output.line(`${rows.length} ${rows.length === 1 ? 'row' : 'rows'}${truncated ? `, more were left out (--limit=${limit})` : ''}${cut > 0 ? `, ${cut} ${cut === 1 ? 'value was' : 'values were'} cut` : ''}`);
    return 0;
  }

  /**
   * The secret columns of the migrations, by table: the same ones the app's own queries are held to. Those of the migrations that ran
   * count too (a pending migration that renames or drops a secret column has not changed the database yet), and so does every column
   * the database has that no migration describes: whether it is secret is not known, so it is treated as secret.
   */
  async #secrets(name: string, driver: 'sqlite' | 'pgsql'): Promise<{ secrets: Map<string, Set<string>>; undescribed: Map<string, Set<string>>; withheld: Set<string> }> {
    const secrets = new Map<string, Set<string>>();
    const add = (table: string, column: string) => {
      let columns = secrets.get(table);
      if (!columns) secrets.set(table, (columns = new Set()));
      columns.add(column);
    };
    // What the database holds is what the migrations that ran made: only that projection describes its columns.
    const projections = [await this.#migrator.readProjection(), await this.#migrator.ranProjection(name)];
    for (const projection of projections) for (const { table, column } of factsOf(projection, driver).secretColumns) add(table, column);
    const { columns: undescribed, withheld } = await this.#migrator.undescribedColumns(name, [projections[1]!]);
    for (const [table, columns] of undescribed) for (const column of columns) add(table, column);
    return { secrets, undescribed, withheld };
  }
}

/** A cell as the table shows it: no control character of the database's text reaches the terminal. */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  return printable(typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value));
}

function wholeNumber(option: string, value: string | boolean | (string | boolean)[] | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(number) || number < 1 || number > max) throw new CommandArgumentsError(`${option} takes a whole number from 1 to ${max}: ${USAGE}`);
  return number;
}

/** The SQL on standard input, to its end; more than {@link MAX_SQL_BYTES} is a wrong call, not a truncated query. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_SQL_BYTES) throw new CommandArgumentsError(`The SQL on standard input is longer than ${MAX_SQL_BYTES / 1024} KiB: ${USAGE}`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}
