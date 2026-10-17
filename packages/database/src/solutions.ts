import { defineSolutions } from '@marmeon/core';
import { DatabaseConnectionError } from './driver.ts';
import { missingTable } from './errors.ts';
import { Migrator } from './migrations/migrator.ts';

/**
 * Solutions for database errors: a missing table — with the migrations that have not run yet (`migrate:status`).
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
]);
