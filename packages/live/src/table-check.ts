import { Application } from '@marmeon/core';
import { withCode } from '@marmeon/core/internal';
import type { HealthCheck } from '@marmeon/core';
import { LiveConfig } from './config.ts';
import { LIVE_HINTS_TABLE } from './database.ts';

/**
 * Readiness: the `live_hints` table counts its ids the way the poller needs — `AUTOINCREMENT` on SQLite, an identity (or serial) column
 * on Postgres. A plain SQLite rowid table hands out the id of a pruned row again, and the poller would take the new row for one it
 * has read. A missing table is reported here with the command that creates it (a missing column is the schema requirement's finding); a
 * table whose definition cannot be read fails the check. Registered by the `LiveServiceProvider` for `LIVE_DRIVER=database`.
 */
export class LiveTableHealthCheck implements HealthCheck {
  static check = 'live-table';

  readonly #app: Application;
  readonly #config: LiveConfig;

  /** @internal Built by the container. */
  constructor(app: Application, config: LiveConfig) {
    this.#app = app;
    this.#config = config;
  }

  async handle(): Promise<string> {
    const { Connections, sql } = await import('@marmeon/database');
    const connections = this.#app.container.make(Connections);
    const db = connections.get(this.#config.connection);
    const { driver } = connections.options(this.#config.connection);
    if (driver === 'sqlite') {
      const { rows } = await sql<{ sql: string | null }>`select sql from sqlite_master where type = 'table' and name = ${LIVE_HINTS_TABLE}`.execute(db);
      if (rows.length === 0) throw missing();
      if (!/\bAUTOINCREMENT\b/i.test(rows[0]!.sql ?? '')) throw new Error(withCode('H7', unsafeIds('its id is not AUTOINCREMENT')));
    } else {
      const { rows } = await sql<{ is_identity: string; column_default: string | null }>`select is_identity, column_default from information_schema.columns
        where table_schema = current_schema() and table_name = ${LIVE_HINTS_TABLE} and column_name = 'id'`.execute(db);
      if (rows.length === 0) throw missing();
      if (rows[0]!.is_identity !== 'YES' && !rows[0]!.column_default?.startsWith('nextval(')) throw new Error(withCode('H7', unsafeIds('its id is neither an identity nor a serial column')));
    }
    return this.#config.connection;
  }
}

function missing(): Error {
  return new Error(withCode('D6', `The ${LIVE_HINTS_TABLE} table is missing, which LIVE_DRIVER=database needs: marmeon make:live-table && marmeon migrate.`));
}

function unsafeIds(why: string): string {
  return `The ${LIVE_HINTS_TABLE} table cannot serve LIVE_DRIVER=database: ${why}, so ids of pruned rows can come back and hints would be skipped. Drop the table and create it again from the migration of \`marmeon make:live-table\` (marmeon migrate).`;
}
