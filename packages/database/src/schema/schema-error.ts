/**
 * A migration touched a table that belongs to the migrator (the record of migrations, the lock), or left the database different from
 * what its plan describes. See `docs/migrations.md#how-the-migrator-keeps-track`.
 */
export class SchemaError extends Error {
  override name = 'SchemaError';
}
