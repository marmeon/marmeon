/**
 * A migration touched a table that belongs to the migrator: its bookkeeping tables, the lock, or the old names that now hold a
 * placeholder. Changing them would make the secret columns or the soft deletes unreadable. See
 * `docs/migrations.md#how-the-migrator-keeps-track`.
 */
export class SchemaError extends Error {
  override name = 'SchemaError';
}
