import { join } from 'node:path';
import { ConsoleLogger, type Logger } from '@marmeon/core';
import { Connections, sql, type ConnectionOptions } from '@marmeon/database';
import { tempDir } from '../../../../scripts/test/temp-dir.js';
import { PGSQL_URL } from './databases.ts';

/** What a test compares schemas on: SQLite always, Postgres when `MARMEON_TEST_PGSQL_URL` is set (`pnpm test:pgsql`). */
export const kinds: readonly ('sqlite' | 'pgsql')[] = ['sqlite', ...(PGSQL_URL ? (['pgsql'] as const) : [])];

export const silent: Logger = Object.assign(new ConsoleLogger(), { debug() {}, info() {} });

/** Everything a table is known by: columns, and the names of indexes and constraints, by their full names. */
export async function describeTable(connections: Connections, name: string) {
  const db = connections.get<any>();
  const introspected = await db.introspection.getTables();
  // Sorted: an upgrade that makes a column again (as a secret) puts it last, and a table is the same whatever the order.
  const columns = introspected.find((table: { name: string }) => table.name === name)!.columns.map((column: { name: string; dataType: string; isNullable: boolean }) => `${column.name}:${column.dataType}:${column.isNullable}`).sort();
  const names = async (query: ReturnType<typeof sql<{ name: string }>>) => (await query.execute(db)).rows.map((row) => row.name).sort();
  if (connections.options().driver === 'sqlite') {
    return { columns, indexes: await names(sql<{ name: string }>`select name from sqlite_master where type = 'index' and tbl_name = ${name} and name not like 'sqlite_autoindex%'`) };
  }
  const table = sql`t.relname = ${name} and t.relnamespace = (select oid from pg_namespace where nspname = current_schema())`;
  return {
    columns,
    indexes: await names(sql<{ name: string }>`select i.relname as name from pg_index x join pg_class t on t.oid = x.indrelid join pg_class i on i.oid = x.indexrelid where ${table}`),
    constraints: await names(sql<{ name: string }>`select c.conname as name from pg_constraint c join pg_class t on t.oid = c.conrelid where ${table}`),
    sequences: await names(sql<{ name: string }>`select s.relname as name from pg_class s join pg_depend d on d.objid = s.oid and d.deptype in ('a', 'i') join pg_class t on t.oid = d.refobjid where s.relkind = 'S' and ${table}`),
  };
}

const connect = (options: ConnectionOptions, managed: boolean) => new Connections({ connections: { default: { ...options, managed } }, root: '/', logger: silent });

/** An empty database: a file of its own, or a new Postgres database. */
export async function open(kind: 'sqlite' | 'pgsql', managed = false) {
  if (kind === 'sqlite') {
    const connections = connect({ driver: 'sqlite', database: join(tempDir('marmeon-auth-schema-'), 'app.sqlite') }, managed);
    return { connections, drop: async () => connections.destroy() };
  }
  const name = `marmeon_auth_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const admin = connect({ driver: 'pgsql', url: PGSQL_URL! }, false);
  await sql`create database ${sql.id(name)}`.execute(admin.get());
  const url = new URL(PGSQL_URL!);
  url.pathname = `/${name}`;
  const connections = connect({ driver: 'pgsql', url: url.href, poolMax: 2 }, managed);
  return {
    connections,
    drop: async () => {
      await connections.destroy();
      await sql`drop database ${sql.id(name)} with (force)`.execute(admin.get());
      await admin.destroy();
    },
  };
}
