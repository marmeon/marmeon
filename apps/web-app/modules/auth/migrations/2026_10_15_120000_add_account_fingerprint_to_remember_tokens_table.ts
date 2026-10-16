import { defineMigration } from '@marmeon/database';

/** The account state a remember-me token was issued under; a token without one (made before this column) is refused. */
export default defineMigration({
  up: (schema) => schema.alter('remember_tokens', (table) => table.string('account_fingerprint', 64).nullable()),
  down: (schema) => schema.alter('remember_tokens', (table) => table.dropColumn('account_fingerprint')),
});
