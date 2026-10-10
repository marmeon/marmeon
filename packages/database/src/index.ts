// Kysely's SQL template, so apps write raw SQL without depending on Kysely themselves.
export { sql } from 'kysely';
export type { Insertable, Kysely, Selectable, Transaction, Updateable } from 'kysely';
export { Connections, Database } from './connections.ts';
export type { QueryEvent, TransactionOptions } from './connections.ts';
// The ambient transaction context lives in core — the queue, events and the HTTP kernel use it without depending
// on the database; apps import it from here, next to `connections.transaction()`.
export { afterCommit, afterRollback, inTransaction, outsideTransaction, TransactionError, TransactionFinishedError } from '@marmeon/core';
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
  Relations,
  Row,
  RowUpdate,
  TableOwners,
  Tables,
  Timestamp,
} from './types.ts';
export { DatabaseConfig, DEFAULT_INFRASTRUCTURE_POOL_MAX, defineConnection, describeConnection } from './config.ts';
export type { ConnectionDefinition, ConnectionDefinitionOptions, ConnectionOptions, PostgresConnection } from './config.ts';
export { DatabaseConnectionError } from './driver.ts';
export { InfrastructureTransactionError } from './infrastructure.ts';
export type { InfrastructureUsage } from './infrastructure.ts';
export { failOnDuplicate, isUniqueViolation, missingTable, uniqueViolationColumns } from './errors.ts';
export { databaseSolutions } from './solutions.ts';
export { DatabaseHealthCheck } from './health.ts';
export { DatabaseServiceProvider } from './provider.ts';
export { DbShowCommand } from './commands/db-show.ts';
export { MigrateCommand, MigrateFreshCommand, MigrateResetCommand, MigrateRollbackCommand, MigrateStatusCommand } from './commands/migrate.ts';
export { DbTypesCommand } from './commands/db-types.ts';
export { DbSeedCommand } from './commands/db-seed.ts';
export { publishMigration, SYSTEM_MODULE } from './commands/publish-migration.ts';
export { defineFactory, Factories, PendingFactory } from './factories.ts';
export type { FactoryContext, FactoryDefinition, MadeAttributes } from './factories.ts';
export { Seeding } from './seeders.ts';
export type { SeedContext, Seeder, SeederClass } from './seeders.ts';
export { defineMigration } from './migrations/migration.ts';
export { TypeGenerator, TYPES_FILE } from './types-gen/generator.ts';
export { columnType, renderTypes } from './types-gen/render.ts';
export type { Rendered, SchemaSnapshot } from './types-gen/render.ts';
export type { Migration } from './migrations/migration.ts';
export { MARKERS_TABLE, Migrator, MIGRATIONS_TABLE, OWNERS_TABLE, SECRETS_TABLE } from './migrations/migrator.ts';
export { SchemaMetadata } from './metadata.ts';
export type { ColumnKind } from './metadata.ts';
export { secret, SecretColumnsPlugin } from './secrets.ts';
export type { Secret, SecretReference } from './secrets.ts';
export type { MigrationFile, MigrationRun, MigrationStatus } from './migrations/migrator.ts';
export type { SchemaMarker } from './introspection.ts';
export { Blueprint, Column, ConstrainedColumn, ForeignIdColumn, TimestampColumn } from './schema/blueprint.ts';
export { Schema } from './schema/schema.ts';
export { belongsTo, hasMany, hasOne, RelationsPlugin } from './relations.ts';
// Also what puts `with()`, `withRelation()` and `withTrashed()` on Kysely's select builder, in types and at runtime.
export type { RelationDefinition, RelationName } from './chain.ts';
export { cursorPaginate, InvalidCursorError, pageQuery, paginate } from './pagination.ts';
export type { CheckPageRequest, CursorEncrypter, CursorOptions, CursorPaginated, PageMeta, PageRequest, Paginated } from './pagination.ts';
export { RecordNotFoundError, Repository } from './repository.ts';
export type { Exact, KeyOf, RepositoryClass, RepositoryStatics, RowOf, TableOf } from './repository.ts';
export { adaptNodeSqlite } from './sqlite.ts';
