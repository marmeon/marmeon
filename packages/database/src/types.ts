import type {
  ColumnType,
  DeleteQueryBuilder,
  DeleteResult,
  Insertable,
  InsertQueryBuilder,
  InsertResult,
  Kysely,
  Selectable,
  Updateable,
  UpdateQueryBuilder,
  UpdateResult,
} from 'kysely';

// Filled in by the generated file (`bespoke db:types`, from the migrations) through declaration merging.

/** Every table of the app: row types by table name. */
export interface Tables {}
/** Which module's migration created each table: `{ users: 'auth' }`. */
export interface TableOwners {}
/** Tables a module deliberately opens to the others for reading and joins (`defineModule({ exposes })`). */
export interface ExposedTables {}
/** The app's modules — so `Database<'user-profil'>` (a typo) is an error. */
export interface Modules {}

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
export type Row<T extends keyof Tables> = Selectable<Tables[T]>;
export type NewRow<T extends keyof Tables> = Insertable<Tables[T]>;
export type RowUpdate<T extends keyof Tables> = Updateable<Tables[T]>;

// --- Module boundaries (E20) --------------------------------------------------------------

type ReadOnlyTable<T> = { [C in keyof T]: ColumnType<Selectable<T>[C & keyof Selectable<T>], never, never> };

/** The tables module `M` owns. */
export type OwnedTables<All, Owners, M extends string> = {
  [T in keyof All as T extends keyof Owners ? (Owners[T] extends M ? T : never) : never]: All[T];
};
/** Other modules' exposed tables — readable, never writable. */
export type ExposedToOthers<All, Owners, Exposed, M extends string> = {
  [T in keyof All as T extends keyof Exposed ? (T extends keyof Owners ? (Owners[T] extends M ? never : T) : never) : never]: ReadOnlyTable<All[T]>;
};
export type ModuleTables<All, Owners, Exposed, M extends string> = OwnedTables<All, Owners, M> & ExposedToOthers<All, Owners, Exposed, M>;

type WriteMethods = 'insertInto' | 'replaceInto' | 'updateTable' | 'deleteFrom' | 'mergeInto' | 'transaction' | 'startTransaction' | 'connection' | 'with' | 'withRecursive' | 'withSchema' | 'withTables' | 'withPlugin' | 'withoutPlugins';

/**
 * The database as module `M` sees it: its own tables for everything, other modules' exposed tables
 * for reading and joins. Writes take only an own table as target — insert, update and delete
 * (restricting the columns alone would not stop `insert` or `delete`, see the E20 spike).
 */
export type ModuleDatabase<All, Owners, Exposed, M extends string> = Omit<Kysely<ModuleTables<All, Owners, Exposed, M>>, WriteMethods> & {
  insertInto<T extends keyof OwnedTables<All, Owners, M> & string>(table: T): InsertQueryBuilder<ModuleTables<All, Owners, Exposed, M>, T, InsertResult>;
  updateTable<T extends keyof OwnedTables<All, Owners, M> & string>(table: T): UpdateQueryBuilder<ModuleTables<All, Owners, Exposed, M>, T, T, UpdateResult>;
  deleteFrom<T extends keyof OwnedTables<All, Owners, M> & string>(table: T): DeleteQueryBuilder<ModuleTables<All, Owners, Exposed, M>, T, DeleteResult>;
  transaction(): { execute<R>(callback: (trx: ModuleDatabase<All, Owners, Exposed, M>) => Promise<R>): Promise<R> };
};
