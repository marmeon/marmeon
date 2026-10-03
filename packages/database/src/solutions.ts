import { defineSolutions } from '@bespokecore/core';
import { missingTable } from './errors.ts';
import { Migrator } from './migrations/migrator.ts';

/**
 * Solutions for database errors (E130): a missing table — with the migrations that have not run yet (`migrate:status`).
 * Text only: the error page shows the command, it never runs it.
 */
export const databaseSolutions = defineSolutions([
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
          command: `bespoke make:migration create_${table}_table`,
          docs: 'packages/database/README.md#migrations-on-another-connection',
        };
      }
      const list = pending ? `${pending.slice(0, 5).join(', ')}${pending.length > 5 ? `, and ${pending.length - 5} more` : ''}` : undefined;
      return {
        title: pending ? `Run the ${pending.length} pending migration${pending.length === 1 ? '' : 's'}` : 'Run the migrations',
        text:
          `The table "${table}" does not exist in the database. ` +
          (list ? `These migrations have not run yet: ${list}. ` : 'Its migration has probably not run yet ("bespoke migrate:status" lists them). ') +
          'In development, "bespoke migrate:fresh --seed" starts over with the seeders.',
        command: 'bespoke migrate',
        docs: 'packages/database/README.md#migrations-on-another-connection',
      };
    },
  },
]);
