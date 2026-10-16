import type { Insertable, Kysely, Selectable, SelectQueryBuilder, Transaction as KyselyTransaction, Updateable } from 'kysely';

/** A connection's query builder, typed by the tables `DB`. See [Queries](../../../docs/queries.md#writing-queries). */
export type Connection<DB> = Kysely<DB>;

/** The query builder inside a transaction: a `Connection` that cannot start another transaction. See [Transactions](../../../docs/transactions.md#transactions-you-control-yourself). */
export type Transaction<DB> = KyselyTransaction<DB>;

/** A select on the tables `DB` that goes on with `where()`, `orderBy()` and the rest. See [Queries](../../../docs/queries.md#writing-queries). */
export type SelectQuery<DB, TB extends keyof DB, O> = SelectQueryBuilder<DB, TB, O>;

/**
 * A row of any table type, as a select returns it: every column with its read type. For a table that is not in `Tables`, such as a
 * package's own; an app writes `Row<'users'>`. See [Queries](../../../docs/queries.md#writing-queries).
 */
export type RowOf<T> = Selectable<T>;

/**
 * A row of any table type, as an insert takes it: generated and defaulted columns may be left out. An app writes `NewRow<'users'>`.
 * See [Queries](../../../docs/queries.md#writing-queries).
 */
export type NewRowOf<T> = Insertable<T>;

/**
 * The columns an update of any table type may set, each with its write type. An app writes `RowUpdate<'users'>`.
 * See [Queries](../../../docs/queries.md#writing-queries).
 */
export type RowUpdateOf<T> = Updateable<T>;

// The SQL template, so apps write raw SQL without importing the query builder's package themselves.
export { sql } from 'kysely';
