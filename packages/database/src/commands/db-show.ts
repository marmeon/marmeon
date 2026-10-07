import type { CommandInput } from 'marmeon';
import { sql } from 'kysely';
import { describeConnection } from '../config.ts';
import { Connections } from '../connections.ts';

/** Laravel's `db:show`: where a connection points, the server version and its tables. */
export class DbShowCommand {
  static command = 'db:show';
  static description = 'Show the database connection and its tables';
  static usage = '[--database=<connection>]';
  static options = { database: { type: 'string' } } as const;

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
    const rows = await Promise.all(
      tables.map(async (table) => {
        const { count } = await db.selectFrom(table.name).select(sql<number>`count(*)`.as('count')).executeTakeFirstOrThrow();
        return [table.schema ? `${table.schema}.${table.name}` : table.name, String(table.columns.length), String(count)];
      }),
    );

    output.line(`Connection  ${name}`);
    output.line(`Target      ${describeConnection(settings)}`);
    output.line(`Server      ${version}`);
    output.line();
    if (rows.length === 0) output.line('No tables yet.');
    else output.table(['TABLE', 'COLUMNS', 'ROWS'], rows);
    return 0;
  }
}
