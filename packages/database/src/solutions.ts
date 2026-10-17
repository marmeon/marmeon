import { defineSolutions } from '@marmeon/core';
import { DatabaseConnectionError } from './driver.ts';
import { BookkeepingVersionError } from './bookkeeping.ts';
import { missingTable } from './errors.ts';
import { Migrator } from './migrations/migrator.ts';

/**
 * Solutions for database errors: a missing table — with the migrations that have not run yet (`migrate:status`) — and bookkeeping
 * the connection cannot read.
 * Text only: the error page shows the command, it never runs it.
 */
export const databaseSolutions = defineSolutions([
  {
    for: Error,
    code: 'D9',
    solve: () => ({
      title: 'Name the columns and read a secret one with secret()',
      text:
        'A secret column never leaves the database by accident. Select the columns the query needs, and read a secret one with ' +
        'secret(eb, …) in a query of its own — a relation never loads one.',
      docs: 'docs/migrations.md#secret-columns',
    }),
  },
  {
    for: DatabaseConnectionError,
    code: 'D11',
    solve: () => ({
      title: 'Check the connection and start the database',
      text:
        'The app has no connection to the database. Start the database, check DB_URL (or the DB_* variables) and the connection\'s name, ' +
        'and for SQLite that the directory of the file exists.',
      docs: 'docs/database.md#configuration',
    }),
  },
  {
    for: Error,
    when: (e) => missingTable(e) !== undefined,
    solve: async (e, { app }) => {
      const table = missingTable(e)!;
      let pending: string[] | undefined;
      try {
        if (app?.container.has(Migrator)) pending = (await app.container.make(Migrator).status()).filter((migration) => migration.batch === undefined).map((migration) => migration.name);
      } catch {
        // No migrations table yet, or the connection is in a failed transaction: say what to run anyway.
      }
      if (pending?.length === 0) {
        return {
          title: `Create the table "${table}" in a migration`,
          text: `Every migration has run, and none creates "${table}". Add one to the module the table belongs to — or check the table's name in the query.`,
          command: `marmeon make:migration create_${table}_table`,
          docs: 'docs/migrations.md#generating-migrations',
        };
      }
      const list = pending ? `${pending.slice(0, 5).join(', ')}${pending.length > 5 ? `, and ${pending.length - 5} more` : ''}` : undefined;
      return {
        title: pending ? `Run the ${pending.length} pending migration${pending.length === 1 ? '' : 's'}` : 'Run the migrations',
        text:
          `The table "${table}" does not exist in the database. ` +
          (list ? `These migrations have not run yet: ${list}. ` : 'Its migration has probably not run yet ("marmeon migrate:status" lists them). ') +
          'In development, "marmeon migrate:fresh --seed" starts over with the seeders.',
        command: 'marmeon migrate',
        docs: 'docs/migrations.md#running-migrations',
      };
    },
  },
  {
    for: BookkeepingVersionError,
    code: 'D1',
    solve: () => ({
      title: 'Update Marmeon, restore the bookkeeping, or adopt the database',
      text:
        'The bookkeeping of the migrator is of a version this release does not read (a newer Marmeon migrated this database), or a table of it is missing or changed. ' +
        'Every query on the connection is refused until it can be read. Update @marmeon/* to the release that migrated the database, or restore the tables from a backup. ' +
        'A database with tables and no bookkeeping that is your own: run "marmeon migrate --adopt-existing" once, which takes the tables over unmarked. Only a database that another tool manages is set to managed: false.',
      docs: 'docs/migrations.md#how-the-migrator-keeps-track',
    }),
  },
  {
    for: BookkeepingVersionError,
    code: 'D2',
    solve: () => ({
      title: 'Move the bookkeeping to the marmeon_ tables',
      text: 'This database still has the bookkeeping of an earlier release. Stop every process of that release, then run the command: it moves the tables and leaves a placeholder under each old name.',
      command: 'marmeon migrate',
      docs: 'docs/migrations.md#how-the-migrator-keeps-track',
    }),
  },
  {
    for: BookkeepingVersionError,
    code: 'D3',
    solve: () => ({
      title: 'Rename your table',
      text:
        'A table of your app has the name of one of the migrator tables (migrations, table_owners, secret_columns or schema_markers), which the framework reserves. ' +
        'Rename it in the database and in the code that uses it, then run the command.',
      command: 'marmeon migrate',
      docs: 'docs/migrations.md#how-the-migrator-keeps-track',
    }),
  },
]);
