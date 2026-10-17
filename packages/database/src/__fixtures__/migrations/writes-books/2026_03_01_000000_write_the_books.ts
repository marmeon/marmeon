import { defineMigration } from '../../../index.ts';

// A migration that empties the list of secret columns by hand.
export default defineMigration({
  up: (schema) => {
    schema.data(async (db) => {
      await db.deleteFrom('marmeon_secret_columns').execute();
    });
  },
});
