import { defineMigration } from '@marmeon/database';

/**
 * A pending change of address (private registration, E146): the new address waits beside the old one until the link sent to it
 * is clicked — `pending_email` signs nobody in. The link's token is kept as a SHA-256 hash, secret (never in `Row<'users'>`).
 */
export default defineMigration({
  up: (schema) =>
    schema.alter('users', (table) => {
      table.string('pending_email', 255).nullable();
      table.string('pending_email_token', 64).nullable().secret();
      table.timestamp('pending_email_expires_at').nullable();
    }),
  down: (schema) =>
    schema.alter('users', (table) => {
      table.dropColumn('pending_email_expires_at');
      table.dropColumn('pending_email_token');
      table.dropColumn('pending_email');
    }),
});
