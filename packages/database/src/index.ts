export { sql } from './builder.ts';
export type { ColumnReference, Connection, NewRowOf, ReferencedType, RowOf, RowUpdateOf, SelectQuery, Transaction } from './builder.ts';
export { Connections, Database } from './connections.ts';
export type { IsolationLevel, QueryEvent, TransactionOptions } from './connections.ts';
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
  PrimaryKeys,
  Relations,
  Row,
  RowUpdate,
  RowWith,
  TableOwners,
  Tables,
  Timestamp,
} from './types.ts';
export { defineConnection } from './config.ts';
export type { ConnectionDefinition, ConnectionDefinitionOptions, ConnectionOptions, PostgresConnectionOptions } from './config.ts';
export { DatabaseConnectionError } from './driver.ts';
export { InfrastructureTransactionError } from './infrastructure.ts';
export type { InfrastructureUsage } from './infrastructure.ts';
export { failOnDuplicate, isUniqueViolation, missingTable, uniqueViolationColumns } from './errors.ts';
export { DatabaseHealthCheck } from './health.ts';
export { DatabaseServiceProvider } from './provider.ts';
export { SchemaRequirements } from './schema-requirements.ts';
export type { ProviderMigrations } from './package-migrations.ts';
export type { ProviderPublishes } from './package-files.ts';
export type { TableRequirement } from './schema-requirements.ts';
export { defineFactory, Factories, PendingFactory } from './factories.ts';
export type { FactoryContext, FactoryDefinition, MadeAttributes } from './factories.ts';
export type { SeedContext, Seeder, SeederClass } from './seeders.ts';
export { defineMigration } from './migrations/migration.ts';
export type { Migration } from './migrations/migration.ts';
export { MigrationLockLostError, MigrationLockTimeoutError } from './migrations/lock.ts';
export type { LockHolder } from './migrations/lock.ts';
export { Migrator } from './migrations/migrator.ts';
export { secret, secretEquals } from './secrets.ts';
export type { Secret, SecretReference } from './secrets.ts';
export type { ChangedMigration, MigrationFile, MigrationStatus } from './migrations/migrator.ts';
export type { ProjectedColumn, ProjectedForeignKey, ProjectedIndex, ProjectedTable, SchemaProjection } from './schema/projection.ts';
export { Blueprint, Column, ConstrainedColumn, ForeignIdColumn, TimestampColumn, UuidColumn } from './schema/blueprint.ts';
export { Schema, SchemaError } from './schema/schema.ts';
export { MigrationStateError } from './migration-state.ts';
// Puts `with()`, `withCount()`, `whereHas()`, `withRelation()` and `withTrashed()` on Kysely's select builder — at runtime (this import) and in the types.
import './chain.ts';
export type { RelationDefinition, RelationName, WithRelations } from './chain.ts';
export type { LinkWriter, RelatedWriter, RelationWriter, WritableRelationName } from './relation-writes.ts';
export { cursorPaginate, InvalidCursorError, pageQuery, paginate } from './pagination.ts';
export type { CheckPageRequest, CursorEncrypter, CursorOptions, CursorPaginated, PageMeta, PageRequest, Paginated } from './pagination.ts';
export { RecordNotFoundError, Repository } from './repository.ts';
export type { Exact, PrimaryKeyOf, RepositoryBindingWith } from './repository.ts';
