import { defineMigration } from '../../../index.ts';

export default defineMigration({
  up: (schema) =>
    schema.alter('accounts', (table) => {
      table.text('recovery_code').nullable().secret();
      table.renameColumn('api_secret', 'totp_secret');
    }),
  down: (schema) =>
    schema.alter('accounts', (table) => {
      table.renameColumn('totp_secret', 'api_secret');
      table.dropColumn('recovery_code');
    }),
});
