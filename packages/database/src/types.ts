import type { NewRowOf, RowOf, RowUpdateOf } from './builder.ts';
import type { RelationName, WithRelations } from './chain.ts';
import type {
  ColumnType,
  DeleteQueryBuilder,
  DeleteResult,
  InsertQueryBuilder,
  InsertResult,
  Kysely,
  UpdateQueryBuilder,
  UpdateResult,
} from 'kysely';

// Filled in by the generated file (`marmeon db:types`, from the migrations) through declaration merging.

/** Every table of the app: row types by table name. */
export interface Tables {}
/** Which module's migration created each table: `{ users: 'auth' }`. */
export interface TableOwners {}
/** Tables a module deliberately opens to the others for reading and joins (`defineModule({ exposes })`). */
export interface ExposedTables {}
/** The app's modules — so `Database<'user-profil'>` (a typo) is an error. */
export interface Modules {}
/**
 * The primary key of each table, as the migrations declare it: a column name (`{ users: 'id'; tags: 'slug' }`) or, for a composite
 * key, the columns (`{ role_user: readonly ['role_id', 'user_id'] }`). A table without a primary key has no entry.
 */
export interface PrimaryKeys {}
/**
 * The relations the foreign keys describe, by table and name: `{ posts: { author: { kind: 'belongsTo'; table: 'users'; … } } }`.
 * A one-relation is `nullable` unless its foreign key is NOT NULL and the related table has no soft deletes.
 * See `docs/migrations.md#relations-from-foreign-keys`.
 */
export interface Relations {}

/** A column the database fills in (identity, default): optional on insert, always there when read. */
export type Generated<T> =
  T extends ColumnType<infer S, infer I, infer U> ? ColumnType<S, I | undefined, U> : ColumnType<T, T | undefined, T>;

/** A JSON column's value. Written as a string: `JSON.stringify(value)` (arrays would otherwise become Postgres arrays). */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** A point in time: read as an ISO-8601 string in UTC, written as a string or a `Date`. */
export type Timestamp = ColumnType<string, string | Date, string | Date>;
/** An exact decimal: read as a string (`'12.50'`), so no precision is lost. */
export type Decimal = ColumnType<string, string | number, string | number>;
/** A JSON column: read parsed, written as `JSON.stringify(value)`. */
export type JsonColumn = ColumnType<Json, string, string>;

/** A row as read, as inserted, as updated. */
export type Row<T extends keyof Tables> = RowOf<Tables[T]>;
export type NewRow<T extends keyof Tables> = NewRowOf<Tables[T]>;
export type RowUpdate<T extends keyof Tables> = RowUpdateOf<Tables[T]>;
/**
 * A row of table `T` with the relations `N` loaded, as `findOrFail(id, { with })` gives it: `RowWith<'posts', 'author' | 'tags'>`,
 * for example as the prop type of a page. See `docs/queries.md#reading`.
 */
export type RowWith<T extends keyof Tables, N extends RelationName<Tables, T>> = WithRelations<Tables, T, N>;

// --- Module boundaries (opt-in via `Database<'module'>`) -------------------------------

type ReadOnlyTable<T> = { [C in keyof T]: ColumnType<RowOf<T>[C & keyof RowOf<T>], never, never> };

/** The tables module `M` owns. */
export type OwnedTables<All, Owners, M extends string> = {
  [T in keyof All as T extends keyof Owners ? (Owners[T] extends M ? T : never) : never]: All[T];
};
/** Other modules' exposed tables — readable, never writable. */
export type ExposedToOthers<All, Owners, Exposed, M extends string> = {
  [T in keyof All as T extends keyof Exposed ? (T extends keyof Owners ? (Owners[T] extends M ? never : T) : never) : never]: ReadOnlyTable<All[T]>;
};
/**
 * `unknown` for a table name `withTables` may declare, `never` for one it may not: a name that is not one literal (an index signature,
 * a template pattern), is qualified (`schema.table`) or aliased (`table as t`) — the query builder would read those as another table —
 * or equals a known table in any letter case (SQLite matches names without regard to case).
 */
type UnknownName<All, K> = K extends string
  ? {} extends Record<K, 1> ? never
    : K extends `${string}.${string}` | `${string} as ${string}` ? never
    : [Extract<Lowercase<keyof All & string>, Lowercase<K>>] extends [never] ? unknown : never
  : never;

/** The arguments `withTables` takes: none — and, for `never` and `any`, which would name every table, one that cannot be given. */
type DeclaredTables<T> = 0 extends 1 & T ? [never] : [T] extends [never] ? [never] : [];

/** Tables Marmeon does not know, declared with `withTables<…>()` on a module's database — readable, never writable. */
export type ForeignTables<Foreign> = 0 extends 1 & Foreign ? {} : [Foreign] extends [never] ? {} : { [T in keyof Foreign]: ReadOnlyTable<Foreign[T]> };
export type ModuleTables<All, Owners, Exposed, M extends string, Foreign = {}> = OwnedTables<All, Owners, M> &
  ExposedToOthers<All, Owners, Exposed, M> &
  ForeignTables<Foreign>;

/**
 * What a module may call on its database besides the writes below: building reads and expressions. Every method of Kysely's
 * `Kysely` and `QueryCreator` is in exactly one of the two lists ({@link WRITE_METHODS} is the other), so a method a newer Kysely
 * adds is withheld from modules until someone classifies it here — `builder-contract.test.ts` fails until then.
 */
export const READ_METHODS = ['selectFrom', 'selectNoFrom', 'fn', 'case', 'dynamic', 'isTransaction'] as const;

/**
 * What a module does not get as Kysely has it: statements that write (given back for own tables only: `insertInto`, `updateTable`,
 * `deleteFrom`, `transaction`; `withTables` is given back typed for reading only), DDL (`schema`), another module's tables by name (`introspection` lists the ones not exposed), raw execution (`executeQuery`, `getExecutor` — `sql\`…\`.execute(db)` would run
 * against any table), anything that changes the connection (`destroy`, plugins, schema), and `$extendTables`,
 * `$omitTables`, `$pickTables`, which hand back a plain `Kysely` without the module's own `insertInto`.
 */
export const WRITE_METHODS = [
  'insertInto', 'replaceInto', 'updateTable', 'deleteFrom', 'mergeInto', 'transaction', 'startTransaction', 'connection',
  'with', 'withRecursive', 'withSchema', 'withTables', 'withPlugin', 'withoutPlugins',
  'schema', 'introspection', 'executeQuery', 'getExecutor', 'destroy', '$extendTables', '$omitTables', '$pickTables',
] as const;

type ReadMethods = (typeof READ_METHODS)[number];

/**
 * The database as module `M` sees it: its own tables for everything, other modules' exposed tables
 * for reading and joins. Writes take only an own table as target — insert, update and delete
 * (restricting the columns alone would not stop `insert` or `delete`).
 */
export type ModuleDatabase<All, Owners, Exposed, M extends string, Foreign = {}> = Pick<Kysely<ModuleTables<All, Owners, Exposed, M, Foreign>>, ReadMethods> & {
  insertInto<T extends keyof OwnedTables<All, Owners, M> & string>(table: T): InsertQueryBuilder<ModuleTables<All, Owners, Exposed, M, Foreign>, T, InsertResult>;
  updateTable<T extends keyof OwnedTables<All, Owners, M> & string>(table: T): UpdateQueryBuilder<ModuleTables<All, Owners, Exposed, M, Foreign>, T, T, UpdateResult>;
  deleteFrom<T extends keyof OwnedTables<All, Owners, M> & string>(table: T): DeleteQueryBuilder<ModuleTables<All, Owners, Exposed, M, Foreign>, T, DeleteResult>;
  transaction(): { execute<R>(callback: (trx: ModuleDatabase<All, Owners, Exposed, M, Foreign>) => Promise<R>): Promise<R> };
  /**
   * Types tables Marmeon does not know (made with `schema.raw()` or by another tool) for reading and joins: `db.withTables<{ legacy_orders: { id: number } }>()`.
   * Never for writing, and never under the name of a table the schema knows — that would reach another module's table that is not exposed.
   * At runtime it returns the same connection. See `docs/queries.md#module-boundaries`.
   */
  withTables<T extends Record<string, Record<string, unknown>> & { [K in keyof T]: UnknownName<All, K> }>(...unnamed: DeclaredTables<T>): ModuleDatabase<All, Owners, Exposed, M, Foreign & T>;
};
