import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Application, ModuleDefinition } from '@marmeon/core';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { freshConnections, PGSQL_URL } from '../__fixtures__/databases.ts';
import { Migrator } from '../index.ts';

// The statements the schema builder writes, held per dialect. An app's old migration runs on a fresh database with whatever the
// builder writes today, and on an updated one with what it wrote then; if the two differ, apps diverge without anyone noticing.
// A group holds the schema statements of its migrations.
//
// `MARMEON_UPDATE_DDL=1 pnpm test:pgsql packages/database/src/schema/ddl.test.ts` writes the files again. It is for a new group, a new
// file: a v1 file that changes is a change of what old migrations build, and a release note has to call it breaking.

// A group may have a sibling directory `<group>-pgsql` for what SQLite cannot do, loaded on Postgres only.
const GROUPS = ['columns', 'indexes', 'alter', 'rename', 'drop', 'checks'];
const POSTGRES_MAJOR = 18;

const directory = (driver: string) => new URL(`../__fixtures__/formats/ddl/${driver}/`, import.meta.url);
const update = process.env.MARMEON_UPDATE_DDL === '1';

/** What the fixture migrations wrote, per group: the statements that change the schema. */
async function record(driver: 'sqlite' | 'pgsql'): Promise<Map<string, string>> {
  const { connections, close } = await freshConnections(driver);
  try {
    if (driver === 'pgsql') {
      const version = Number((await sql<{ v: string }>`select current_setting('server_version_num') as v`.execute(connections.get())).rows[0]!.v);
      if (Math.floor(version / 10000) !== POSTGRES_MAJOR) throw new Error(`the pgsql DDL fixtures are written against Postgres ${POSTGRES_MAJOR} (compose.yaml), not ${version}`);
    }
    let statements: string[] = [];
    connections.onQuery((query) => {
      const text = query.sql.trim();
      // Reads are not what a migration writes, and neither are the transaction, the record of migrations and the migration lock.
      if (/^(select|with|begin|commit|rollback|savepoint|release|pragma)\b/i.test(text)) return;
      if (/\b(migration_lock|migrations)\b/i.test(text)) return;
      statements.push(query.parameters.length ? `${text};\n-- ${JSON.stringify(query.parameters)}` : `${text};`);
    });
    const written = new Map<string, string>();
    for (const group of GROUPS) {
      // The groups before it are included: they ran already, and the migrator needs them to know the tables this one changes.
      const included = GROUPS.slice(0, GROUPS.indexOf(group) + 1);
      const sibling = (name: string) => driver === 'pgsql' && existsSync(new URL(`../__fixtures__/migrations/ddl/${name}-pgsql/`, import.meta.url));
      const directories = included.flatMap((name) => [name, ...(sibling(name) ? [`${name}-pgsql`] : [])]);
      const modules: ModuleDefinition[] = directories.map((directory) => ({ name: 'ddl', migrations: new URL(`../__fixtures__/migrations/ddl/${directory}/`, import.meta.url) }));
      statements = [];
      await new Migrator({ modules, root: '/' } as unknown as Application, connections).migrate();
      written.set(group, `${statements.join('\n')}\n`);
    }
    return written;
  } finally {
    await close();
  }
}

describe.each(['sqlite', 'pgsql'] as const)('the DDL the schema builder writes on %s', (driver) => {
  // A skipped test is listed as skipped: a run without Postgres does not pass for it.
  it.skipIf(driver === 'pgsql' && !PGSQL_URL)('is the one an earlier release wrote, byte for byte', async () => {
    const written = await record(driver);
    const files = directory(driver);
    if (update) {
      mkdirSync(files, { recursive: true });
      for (const [name, text] of written) writeFileSync(new URL(`v1-${name}.sql`, files), text);
    }
    expect(readdirSync(files).sort()).toEqual([...written.keys()].map((name) => `v1-${name}.sql`).sort());
    const message = 'the schema builder writes other SQL than an earlier release — an old migration would build another database; add a new option instead';
    for (const [name, text] of written) {
      expect(text, `${message} (v1-${name}.sql on ${driver})`).toBe(readFileSync(new URL(`v1-${name}.sql`, files), 'utf8'));
    }
  });
});
