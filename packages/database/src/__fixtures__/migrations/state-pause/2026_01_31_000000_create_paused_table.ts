import { defineMigration } from '../../../index.ts';

/** Where a test and the migration below meet: the migration says it is in its data step, then waits to be let go. */
export const PAUSE = Symbol.for('marmeon.test.migration-pause');
export interface Pause {
  entered(): void;
  released: Promise<void>;
}

// A migration whose transaction stays open until the test lets it go, with a data step that sees the table the plan created.
export default defineMigration({
  up: (schema) => {
    schema.create('paused', (table) => {
      table.id();
      table.string('name');
      table.softDeletes();
    });
    schema.data(async () => {
      const pause = (globalThis as Record<symbol, Pause | undefined>)[PAUSE];
      pause?.entered();
      await pause?.released;
    });
  },
  down: (schema) => schema.drop('paused'),
});
