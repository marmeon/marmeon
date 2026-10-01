// Data access on Kysely (E6): connections, the typed `Database`, and — in the next steps —
// migrations per module, generated table types, repositories and factories.
// Kysely's SQL template, so apps write raw SQL without depending on Kysely themselves.
export { sql } from 'kysely';
export type { Insertable, Kysely, Selectable, Transaction, Updateable } from 'kysely';
export { Connections, Database } from './connections.ts';
export type { QueryEvent } from './connections.ts';
export type {
  Decimal,
  ExposedTables,
  Generated,
  Json,
  JsonColumn,
  ModuleDatabase,
  ModuleTables,
  Modules,
  NewRow,
  Row,
  RowUpdate,
  TableOwners,
  Tables,
  Timestamp,
} from './types.ts';
export { DatabaseConfig, defineConnection, describeConnection } from './config.ts';
export type { ConnectionDefinition, ConnectionOptions } from './config.ts';
export { DatabaseConnectionError } from './driver.ts';
export { isUniqueViolation } from './errors.ts';
export { DatabaseServiceProvider } from './provider.ts';
export { DbShowCommand } from './commands/db-show.ts';
export { MigrateCommand, MigrateFreshCommand, MigrateResetCommand, MigrateRollbackCommand, MigrateStatusCommand } from './commands/migrate.ts';
export { DbTypesCommand } from './commands/db-types.ts';
export { DbSeedCommand } from './commands/db-seed.ts';
export { defineFactory, Factories, PendingFactory } from './factories.ts';
export type { FactoryContext, FactoryDefinition } from './factories.ts';
export { Seeding } from './seeders.ts';
export type { SeedContext, Seeder, SeederClass } from './seeders.ts';
export { defineMigration } from './migrations/migration.ts';
export { TypeGenerator, TYPES_FILE } from './types-gen/generator.ts';
export { columnType, renderTypes } from './types-gen/render.ts';
export type { Rendered, SchemaSnapshot } from './types-gen/render.ts';
export type { Migration } from './migrations/migration.ts';
export { Migrator, MIGRATIONS_TABLE, OWNERS_TABLE, SECRETS_TABLE } from './migrations/migrator.ts';
export { SchemaMetadata } from './metadata.ts';
export type { ColumnKind } from './metadata.ts';
export { secret, SecretColumnsPlugin } from './secrets.ts';
export type { Secret, SecretReference } from './secrets.ts';
export type { MigrationFile, MigrationRun, MigrationStatus } from './migrations/migrator.ts';
export { Blueprint, Column, ConstrainedColumn, ForeignIdColumn, TimestampColumn } from './schema/blueprint.ts';
export { Schema } from './schema/schema.ts';
export { belongsTo, hasMany, hasOne, RelationsPlugin } from './relations.ts';
export { cursorPaginate, paginate, paginationFrom } from './pagination.ts';
export type { CursorPaginated, PageMeta, Paginated } from './pagination.ts';
export { RecordNotFoundError, Repository } from './repository.ts';
export type { Exact, KeyOf, RepositoryClass, RepositoryStatics, RowOf, TableOf } from './repository.ts';
export { adaptNodeSqlite } from './sqlite.ts';
