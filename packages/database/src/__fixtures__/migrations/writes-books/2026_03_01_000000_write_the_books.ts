import { defineMigration } from '../../../index.ts';

// A migration that empties the list of secret columns by hand.
export default defineMigration({
  up: async (schema) => {
    await schema.db.deleteFrom('marmeon_secret_columns').execute();
  },
});
