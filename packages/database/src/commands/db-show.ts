import type { CommandInput } from 'marmeon';
import { sql } from 'kysely';
import { describeConnection } from '../config.ts';
import { Connections } from '../connections.ts';

/**
 * Shows where a connection points, the server version and its tables. The target is `describeConnection`'s text and
 * nothing else — the password, every query parameter except host/port/sslmode/application_name, and the fragment never
 * reach the output, in text or `--json`.
 */
export class DbShowCommand {
  static command = 'db:show';
  static description = 'Show the database connection and its tables';
  static usage = '[--database=<connection>] [--json]';
  static options = { database: { type: 'string' }, json: { type: 'boolean' } } as const;

  readonly #connections: Connections;

  constructor(connections: Connections) {
    this.#connections = connections;
  }

  async handle({ options, output }: CommandInput): Promise<number> {
    const name = typeof options.database === 'string' ? options.database : 'default';
    const settings = this.#connections.options(name);
    const db = this.#connections.get<Record<string, Record<string, unknown>>>(name);

    const version =
      settings.driver === 'sqlite'
        ? `SQLite ${(await sql<{ v: string }>`select sqlite_version() as v`.execute(db)).rows[0]?.v}`
        : ((await sql<{ v: string }>`select version() as v`.execute(db)).rows[0]?.v.split(' on ')[0] ?? 'PostgreSQL');
    const tables = await db.introspection.getTables();
    const found = await Promise.all(
      tables.map(async (table) => {
        const { count } = await db.selectFrom(table.name).select(sql<number>`count(*)`.as('count')).executeTakeFirstOrThrow();
        return { name: table.name, schema: table.schema ?? null, columns: table.columns.length, rows: Number(count) };
      }),
    );
    const described = describeConnection(settings);

    if (options.json === true) {
      output.json({ format: 1, connection: name, driver: settings.driver, target: described.slice(settings.driver.length + 1), server: version, tables: found, warnings: [] });
      return 0;
    }
    const rows = found.map((table) => [table.schema ? `${table.schema}.${table.name}` : table.name, String(table.columns), String(table.rows)]);

    output.line(`Connection  ${name}`);
    output.line(`Target      ${described}`);
    output.line(`Server      ${version}`);
    output.line();
    if (rows.length === 0) output.line('No tables yet.');
    else output.table(['TABLE', 'COLUMNS', 'ROWS'], rows);
    return 0;
  }
}
