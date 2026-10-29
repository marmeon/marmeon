import { err, ok, type Result } from '@marmeon/core';
import { errOfRollback, rollBackOnErr, withCode } from '@marmeon/core/internal';
import { HttpError, type RouteBinder, type RouteBindingContext, type RouteBindingWith } from '@marmeon/router';
import { sql } from 'kysely';
import type { Connection, NewRowOf, RowOf, RowUpdateOf, SelectQuery, Transaction } from './builder.ts';
import { Connections } from './connections.ts';
import { isUniqueViolation, uniqueViolationColumns } from './errors.ts';
import type { RelationName, WithRelations } from './chain.ts';
import { keyset, paginate, type CheckPageRequest, type Paginated, type PageRequest } from './pagination.ts';
import { TOUCH_COLUMN } from './placeholders.ts';
import { relationWriter, type RelationWriter, type WritableRelationName } from './relation-writes.ts';
import { metadataOf, softDelete, softDeleteFilter } from './schema-resolver.ts';
import type { ColumnKind, SchemaMetadata } from './metadata.ts';
import type { PrimaryKeys, Tables } from './types.ts';

/** `findOrFail` found nothing: answers 404 — without telling the client what was looked up. */
export class RecordNotFoundError extends HttpError {
  override name = 'RecordNotFoundError';
  readonly table: string;
  readonly key: unknown;

  constructor(table: string, key: unknown) {
    super(404);
    this.table = table;
    this.key = key;
  }
}

/**
 * The type of a table's primary key column — `never` for a table without a primary key or with a composite one, which no
 * repository method takes. See `docs/queries.md#table-types`.
 */
export type PrimaryKeyOf<T extends keyof DB, DB = Tables> = T extends keyof PrimaryKeys
  ? PrimaryKeys[T] extends infer C extends string
    ? C extends keyof RowOf<DB[T]>
      ? RowOf<DB[T]>[C]
      : never
    : never
  : never;

/** What a repository class declares statically, next to `extends Repository<'users'>`. */
export interface RepositoryStatics {
  /** The table — a runtime value, like `static request` on controllers. */
  readonly table: string;
  /** Default connection name. */
  readonly connection?: string;
  /** The column a route parameter matches (`Route.bind`) — default the table's primary key. */
  readonly routeKey?: string;
  /**
   * What a route parameter must look like before it is looked up — default by the kind of the route key's column: digits for an
   * integer, a UUID for a uuid, at most 255 characters otherwise (anything else is a 404 without a query; Postgres would fail
   * comparing a bigint with `'abc'`).
   */
  readonly routeKeyPattern?: RegExp;
}

let savepoints = 0;

/** What a UUID looks like (any version, either case); anything else on a uuid column would make Postgres throw `22P02`. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `V`, but keys it does not share with `Shape` become `never` — so a variable with an extra field
 * (`update(id, ctx.body)` after a column was renamed) is an error. TypeScript's excess-property check
 * only covers object literals.
 */
export type Exact<V, Shape> = V & { [K in Exclude<keyof V, keyof Shape>]: never };

/** The `err` of `tryInsert()` and `tryUpdate()` on a taken value: `columns` are the columns of the unique index that was hit, empty when unknown. See `docs/queries.md#writing`. */
export interface DuplicateError {
  readonly kind: 'duplicate';
  readonly columns: readonly string[];
}

/**
 * Optional base for a table's repository — rows in, rows out: no identity map, no lazy loading, no dirty tracking. Declare
 * the table again as a value (`static table = 'users' as const`); the only dependency is the connection, which is what lets
 * {@link using} bind one to a transaction. Soft deletes and timestamps follow the table's migration (`softDeletes()`,
 * `timestamps()`). See `docs/queries.md#repositories`.
 */
export abstract class Repository<T extends keyof DB & string, DB = Tables> implements RouteBinder<RowOf<DB[T]>> {
  /** Says a route binding scoped by a parent (`scopedBy`) is looked up within it: see `resolveRouteBinding`. */
  static readonly routeBindingScoped = true;
  /** Types only: `Route.bind('post', PostRepository, { with: ['author'] })` takes the table's relations and types them on the row. */
  declare readonly routeBindingWith?: RepositoryBindingWith<DB, T>;
  readonly #db: Connection<DB>;
  /** The app's connections, for `transaction()`. */
  readonly #connections: Connections | undefined;

  constructor(connections: Connections) {
    const statics = this.#statics();
    if (typeof statics.table !== 'string') {
      throw new TypeError(`${new.target.name} needs its table as a runtime value: static table = '…' as const;`);
    }
    this.#db = connections.get<DB>(statics.connection);
    // Absent for a repository bound with `using(…)` (its stand-in only hands out the transaction).
    this.#connections = typeof (connections as Partial<Connections>).transaction === 'function' ? connections : undefined;
  }

  /** The table name (from `static table`). */
  get table(): T {
    return this.#statics().table as T;
  }

  /** The connection or the transaction this instance works in. */
  protected get db(): Connection<DB> {
    return this.#db;
  }

  /** The base class works on a table only known at runtime — typed at its public surface instead. */
  get #untyped(): Connection<any> {
    return this.#db as Connection<any>;
  }

  get #name(): string {
    return this.#statics().table;
  }

  /**
   * The same repository, working inside `trx` — explicitly. Inside `connections.transaction(…)` a repository joins the
   * transaction by itself; `using(trx)` is for transactions you control yourself (Kysely's
   * `db.startTransaction()`, a second connection at the same time, code outside the transaction's call chain).
   */
  using(trx: Transaction<DB> | Connection<DB>): this {
    // A real instance (a copy via Object.create would lack the private fields and methods of its class),
    // built with connections that hand out `trx`.
    const Class = this.constructor as new (connections: Connections) => this;
    if (Class.length > 1) {
      throw new TypeError(
        `${Class.name}.using() builds the repository with the transaction as its only dependency, but its constructor takes ${Class.length}. ` +
          'Keep repositories to data access (the connection); give other dependencies to the service that uses them.',
      );
    }
    return new Class({ get: () => trx } as unknown as Connections);
  }

  /**
   * Runs `callback` in a transaction of the repository's connection — `connections.transaction()`: everything
   * awaited inside joins it, other repositories too. Inside another transaction it becomes a savepoint (also for a
   * repository bound with `using(trx)` — Kysely itself refuses a transaction in a transaction). An `err` returned by the
   * callback rolls back like a thrown error and is returned. See `docs/transactions.md#returning-an-err`.
   */
  async transaction<R>(callback: (repository: this) => Promise<R>): Promise<R> {
    const db = this.db;
    if (!db.isTransaction) {
      if (this.#connections) return this.#connections.transaction(() => callback(this), this.#statics().connection ? { connection: this.#statics().connection! } : {});
      try {
        return await db.transaction().execute(async (trx) => rollBackOnErr(await callback(this.using(trx))));
      } catch (error) {
        const result = errOfRollback(error);
        if (result) return result as R;
        throw error;
      }
    }
    const name = sql.raw(`repository_savepoint_${++savepoints}`);
    await sql`savepoint ${name}`.execute(db);
    try {
      const result = rollBackOnErr(await callback(this));
      await sql`release savepoint ${name}`.execute(db);
      return result;
    } catch (error) {
      await sql`rollback to savepoint ${name}`.execute(db);
      const result = errOfRollback(error);
      if (result) return result as R;
      throw error;
    }
  }

  /**
   * A select on the table — without soft-deleted rows when its migration called `softDeletes()`; `query().withTrashed()` keeps
   * them.
   */
  query(): SelectQuery<DB, T, {}> {
    return this.#untyped.selectFrom(this.#name).where(softDeleteFilter(this.#name)) as unknown as SelectQuery<DB, T, {}>;
  }

  /**
   * One page of a query on this repository's connection — which page: the route's parsed query (`ctx.query`, with `pageQuery()` in
   * its schema) or `{ page, perPage }`: `this.paginate(this.query().selectAll().orderBy('id'), ctx.query)`.
   */
  paginate<TB extends keyof DB, O, const Q = PageRequest>(query: SelectQuery<DB, TB, O>, request?: CheckPageRequest<Q>): Promise<Paginated<O>> {
    return paginate(this.db, query, request as PageRequest | undefined);
  }

  /**
   * The row with this primary key, or `undefined`. On a uuid key, a value that is no UUID finds nothing — without a query. A table
   * without a single-column primary key is refused with a `TypeError`: use `query()`.
   */
  async find(id: PrimaryKeyOf<T, DB>): Promise<RowOf<DB[T]> | undefined> {
    const key = await this.#lookup(id);
    if (key === undefined) return undefined;
    return (await this.query().selectAll().where(key.column as never, '=', key.value as never).executeTakeFirst()) as RowOf<DB[T]> | undefined;
  }

  /**
   * The row, or a 404 (`RecordNotFoundError`) — with the relations `with` names loaded in the same query, as `with()` loads them.
   * See `docs/queries.md#reading`.
   */
  async findOrFail<const W extends readonly RelationName<DB, T>[] = []>(id: PrimaryKeyOf<T, DB>, options: { readonly with?: W } = {}): Promise<WithRelations<DB, T, W[number]>> {
    const key = await this.#lookup(id);
    const row = key === undefined ? undefined : await this.#loading(this.query().selectAll().where(key.column as never, '=', key.value as never), options.with).executeTakeFirst();
    if (!row) throw new RecordNotFoundError(this.table, id);
    return row as WithRelations<DB, T, W[number]>;
  }

  /**
   * The first row whose `column` holds `value` (`null` finds a NULL) — `undefined` when there is none. Never a soft-deleted one.
   * See `docs/queries.md#reading`.
   */
  findBy<C extends keyof RowOf<DB[T]> & string>(column: C, value: RowOf<DB[T]>[C]): Promise<RowOf<DB[T]> | undefined> {
    return this.#firstWhere('findBy', { [column]: value });
  }

  /** The first row that holds every value of `values` (`null` finds a NULL) — `undefined` when there is none. See `docs/queries.md#reading`. */
  firstWhere<V extends Partial<RowOf<DB[T]>>>(values: Exact<V, RowOf<DB[T]>>): Promise<RowOf<DB[T]> | undefined> {
    return this.#firstWhere('firstWhere', values as Record<string, unknown>);
  }

  /** One column of every row, without the soft-deleted ones. A secret column is refused. See `docs/queries.md#reading`. */
  async pluck<C extends keyof RowOf<DB[T]> & string>(column: C): Promise<RowOf<DB[T]>[C][]> {
    const rows = await this.query().select(column as never).execute();
    return rows.map((row) => (row as Record<string, unknown>)[column]) as RowOf<DB[T]>[C][];
  }

  /**
   * The rows in batches of `size`, by their primary key — no offset: rows removed meanwhile do not make it skip others. A row added
   * meanwhile comes at the end — or, when another transaction commits it later with a smaller key, not at all. One query per batch; `query` narrows what is read (conditions, relations). See `docs/queries.md#reading`.
   *
   * ```ts
   * for await (const users of this.chunk(500, (query) => query.where('email_verified_at', 'is', null))) …
   * ```
   */
  async *chunk<O = RowOf<DB[T]>>(
    size: number,
    query?: (query: SelectQuery<DB, T, RowOf<DB[T]>>) => SelectQuery<DB, T, O>,
  ): AsyncGenerator<O[], void, undefined> {
    if (!Number.isSafeInteger(size) || size < 1) throw new RangeError(`chunk() takes a size that is a whole number ≥ 1, got ${size}.`);
    const all = this.query().selectAll() as unknown as SelectQuery<DB, T, RowOf<DB[T]>>;
    const base = query ? query(all) : (all as unknown as SelectQuery<DB, T, O>);
    const column = await this.#keyColumn();
    // The batches go by key: another order would be dropped without a word.
    if (base.toOperationNode().orderBy) throw new TypeError('chunk() reads the rows in the order of their primary key — leave orderBy() out of its callback.');
    let after: unknown[] | undefined;
    for (;;) {
      const rows = await keyset(base, [`${this.#name}.${column}`], after, 'asc', size).execute();
      const last = rows.at(-1) as Record<string, unknown> | undefined;
      if (last && !Object.hasOwn(last, column)) throw new TypeError(`chunk() reads the rows by their key "${column}", but the query does not select it — keep it in the selection.`);
      if (rows.length > 0) yield rows;
      if (!last || rows.length < size) return;
      after = [last[column]];
    }
  }

  async exists(id: PrimaryKeyOf<T, DB>): Promise<boolean> {
    const key = await this.#lookup(id);
    if (key === undefined) return false;
    const row = await this.query().select(sql<number>`1`.as('found')).where(key.column as never, '=', key.value as never).executeTakeFirst();
    return row !== undefined;
  }

  async count(): Promise<number> {
    const row = await this.query().select(sql<number | string>`count(*)`.as('count')).executeTakeFirstOrThrow();
    return Number((row as { count: number | string }).count);
  }

  /** Inserts a row and returns it as stored — defaults and generated id included. */
  async insert<V extends NewRowOf<DB[T]>>(values: Exact<V, NewRowOf<DB[T]>>): Promise<RowOf<DB[T]>> {
    return (await this.#untyped
      .insertInto(this.#name)
      .values(values as Record<string, unknown>)
      .returningAll()
      .executeTakeFirstOrThrow()) as RowOf<DB[T]>;
  }

  /**
   * Inserts a row unless a unique index already holds its values — then an `err` of kind `duplicate` (an e-mail that is taken,
   * say) whose `columns` name the index that was hit (empty when the columns are not known), so a table with several unique indexes
   * tells "code taken" from "address taken". Race-free, unlike checking first. Runs in a savepoint: on Postgres a failed statement aborts the whole surrounding
   * transaction. Returned from a transaction's callback, the `err` rolls that transaction back. See `docs/queries.md#writing`.
   */
  async tryInsert<V extends NewRowOf<DB[T]>>(values: Exact<V, NewRowOf<DB[T]>>): Promise<Result<RowOf<DB[T]>, DuplicateError>> {
    try {
      return ok(await this.transaction((repository) => repository.insert(values)));
    } catch (error) {
      if (isUniqueViolation(error)) return err({ kind: 'duplicate', columns: await this.#duplicateColumns(error) });
      throw error;
    }
  }

  /**
   * Updates a row unless a unique index already holds the new values — then an `err` of kind `duplicate`; of kind `missing` when
   * there is no such row (or it is soft-deleted). In a savepoint, like `tryInsert`, and with the same `columns`. See `docs/queries.md#writing`.
   */
  async tryUpdate<V extends RowUpdateOf<DB[T]>>(
    id: PrimaryKeyOf<T, DB>,
    values: Exact<V, RowUpdateOf<DB[T]>>,
  ): Promise<Result<RowOf<DB[T]>, DuplicateError | { kind: 'missing' }>> {
    try {
      const row = await this.transaction((repository) => repository.update(id, values));
      return row ? ok(row) : err({ kind: 'missing' });
    } catch (error) {
      if (isUniqueViolation(error)) return err({ kind: 'duplicate', columns: await this.#duplicateColumns(error) });
      throw error;
    }
  }

  /**
   * Writes through a relation of the row `id`: `sync()`, `attach()` and `detach()` the links of a belongsToMany, `create()` and
   * `createMany()` rows of a hasMany or a hasOne with the foreign key set — each in a transaction. A missing or soft-deleted row
   * is a 404 (`RecordNotFoundError`); a link to a missing or soft-deleted related row is refused. See
   * `docs/queries.md#writing-through-relations`.
   */
  relation<N extends WritableRelationName<DB, T>>(id: PrimaryKeyOf<T, DB>, name: N): RelationWriter<DB, T, N> {
    return relationWriter({
      table: this.#name,
      name,
      missing: () => new RecordNotFoundError(this.table, id),
      run: (work) =>
        this.transaction(async (repository) => {
          const metadata = await repository.#schema(`relation('${name}')`);
          // The row's key, locked on Postgres: a concurrent soft delete of it waits until the links are written.
          const key = async (column: string) => {
            const idKey = await repository.#lookup(id);
            if (idKey === undefined) return undefined;
            let query = repository.query().select(column as never).where(idKey.column as never, '=', idKey.value as never);
            if (metadata.driver === 'pgsql') query = query.forUpdate();
            const row = (await query.executeTakeFirst()) as Record<string, unknown> | undefined;
            return row && { value: row[column] };
          };
          return work(repository.#untyped, key, metadata);
        }),
    }) as unknown as RelationWriter<DB, T, N>;
  }

  /**
   * Updates a row and returns it — `undefined` when there is none (or it is soft-deleted). Sets `updated_at` when the
   * table's migration called `timestamps()`, unless `values` set it.
   */
  async update<V extends RowUpdateOf<DB[T]>>(id: PrimaryKeyOf<T, DB>, values: Exact<V, RowUpdateOf<DB[T]>>): Promise<RowOf<DB[T]> | undefined> {
    const key = await this.#lookup(id);
    if (key === undefined) return undefined;
    return (await this.#untyped
      .updateTable(this.#name)
      .set({ ...(values as Record<string, unknown>), [TOUCH_COLUMN]: new Date() })
      .where(key.column, '=', key.value)
      .where(softDeleteFilter(this.#name))
      .returningAll()
      .executeTakeFirst()) as RowOf<DB[T]> | undefined;
  }

  /** Deletes a row — sets `deleted_at` instead when the table's migration called `softDeletes()`. Returns whether there was one. */
  async delete(id: PrimaryKeyOf<T, DB>): Promise<boolean> {
    const key = await this.#lookup(id);
    if (key === undefined) return false;
    const result = await this.#untyped.deleteFrom(this.#name).where(key.column, '=', key.value).where(softDelete(this.#name)).executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  /** Deletes a row for real, soft deletes or not. */
  async forceDelete(id: PrimaryKeyOf<T, DB>): Promise<boolean> {
    const key = await this.#lookup(id);
    if (key === undefined) return false;
    const result = await this.#untyped.deleteFrom(this.#name).where(key.column, '=', key.value).executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  /** Brings a soft-deleted row back. Returns whether there was one: `false` for a row that is not deleted, or missing. */
  async restore(id: PrimaryKeyOf<T, DB>): Promise<boolean> {
    const key = await this.#lookup(id);
    if (key === undefined) return false;
    const result = await this.#untyped.updateTable(this.#name).set({ deleted_at: null }).where(key.column, '=', key.value).where('deleted_at', 'is not', null).executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  /**
   * `Route.bind('user', UserRepository)`: the row whose route key (the primary key unless `static routeKey` names another column) is `value` — within the parent
   * for scoped bindings (`scope.column` = the column of the parent that the foreign key references, its primary key as a rule), so
   * another parent's row is a 404 — with the relations the binding names (`{ with }`) loaded in the same query. A value that cannot
   * be a key (not digits on an integer, not a UUID on a uuid, over 255 characters on text) is a 404 without a query. A scope column
   * without a foreign key, or a route key of a kind that needs a `routeKeyPattern` (timestamp, boolean, json, decimal), is a `TypeError`.
   */
  async resolveRouteBinding(value: string, binding: RouteBindingContext): Promise<RowOf<DB[T]> | undefined> {
    const key = this.#statics().routeKey ?? (await this.#keyColumn());
    const kind = await this.#kind(key);
    // The pattern follows the column, so a value that cannot be a key never reaches the database: Postgres would throw `22P02`
    // on text compared with a bigint or a uuid, and a string of any length would go into the index.
    const custom = this.#statics().routeKeyPattern;
    if (!custom && kind !== undefined && kind !== 'integer' && kind !== 'uuid' && kind !== 'other') {
      throw new TypeError(`${this.#name}.${key} is a column that cannot be matched against text unchecked — set a static routeKeyPattern on ${this.constructor.name}.`);
    }
    const pattern = custom ?? (kind === 'integer' ? /^\d{1,15}$/ : kind === 'uuid' ? UUID : /^[\s\S]{1,255}$/);
    if (!pattern.test(value)) return undefined;
    // An integer is compared as a number (Postgres refuses bigint = text); a uuid as the lower-case text SQLite stores.
    const compared = kind === 'integer' ? Number(value) : kind === 'uuid' ? value.toLowerCase() : value;
    if (typeof compared === 'number' && !Number.isSafeInteger(compared)) return undefined;
    let query = this.#loading(this.query().selectAll(), binding.with).where(key as never, '=', compared as never);
    if (binding.scope) {
      // The parent's column the foreign key references — its primary key as a rule, a slug for a table keyed by one.
      const column = binding.scope.column;
      const relation = [...((await this.#schema('A scoped binding')).relations.get(this.#name)?.values() ?? [])].find((r) => r.kind === 'belongsTo' && r.foreignKey === column);
      if (!relation) throw new TypeError(`${this.#name}.${column} is not a foreign key (or its relation could not be derived — see marmeon db:types), so a binding scoped by it has no parent column to compare with — scope by a column that references the parent's table.`);
      const parent = (binding.scope.parent as Record<string, unknown> | undefined)?.[relation.targetKey];
      if (parent === undefined) return undefined;
      query = query.where(column as never, '=', parent as never);
    }
    return (await query.executeTakeFirst()) as RowOf<DB[T]> | undefined;
  }

  /**
   * The row whose route key (`static routeKey`, default the primary key) is `value`, as a route binding finds it, for lookups outside of
   * routes — `undefined` when there is none, or when `value` cannot be a key. See `docs/queries.md#reading`.
   */
  findByRouteKey(value: string): Promise<RowOf<DB[T]> | undefined> {
    return this.resolveRouteBinding(value, {} as RouteBindingContext);
  }

  /**
   * The kind of `column`, once the schema is known: a query on this connection loads it (once per process, or after a schema
   * change). `undefined` on a connection without Marmeon's plugins, where nothing is known.
   */
  async #kind(column: string): Promise<ColumnKind | undefined> {
    const metadata = metadataOf(this.#db);
    if (!metadata) return undefined;
    if (!metadata.fresh) await sql`select 1`.execute(this.#db);
    return metadata.kinds.get(this.#name)?.get(column);
  }

  /**
   * The table's columns a unique violation hit. An index the migrations describe is looked up by its name (Postgres's constraint,
   * SQLite's `index '…'`): exact, also when the driver gives no detail. Any other index is read from what the driver reports: the
   * name where that is all there is (the longest known columns first, so `tenant_id` wins over `id`), otherwise the words of its
   * message that are columns of the table. `[]` on a connection without Marmeon's plugins, where no column is known.
   */
  async #duplicateColumns(error: unknown): Promise<readonly string[]> {
    const metadata = metadataOf(this.#db);
    if (!metadata) return [];
    if (!metadata.fresh) await sql`select 1`.execute(this.#db);
    const named = (error as { constraint?: unknown }).constraint;
    const name = typeof named === 'string' ? named : /UNIQUE constraint failed: index '(.+)'/.exec(String((error as Error).message))?.[1];
    const indexed = name === undefined ? undefined : metadata.projection?.tables.get(this.#name)?.indexes.find((index) => index.unique && index.name === name);
    if (indexed) return indexed.columns;
    const kinds = metadata.kinds.get(this.#name);
    const detailed = typeof (error as { detail?: unknown }).detail === 'string';
    if (name !== undefined && !detailed) return columnsInName(name, this.#name, [...(kinds?.keys() ?? [])]);
    return [...new Set(uniqueViolationColumns(error))].filter((word) => kinds?.has(word));
  }

  /**
   * The table's primary key column, from the schema metadata. Never a guess: a table without a primary key or with a composite one
   * cannot be looked up by one value, and a reader that guessed `id` would find another row or none.
   */
  async #keyColumn(): Promise<string> {
    const metadata = await this.#schema('A lookup by primary key');
    if (!metadata.columns.has(this.#name)) {
      throw new TypeError(`${this.#name} is not a table the migrations created with schema.create(), so its primary key is unknown — create it with schema.create() or use query() (docs/migrations.md#raw-sql).`);
    }
    const key = metadata.primaryKeys.get(this.#name);
    if (key?.length !== 1) throw new TypeError(`${this.#name} has no single-column primary key — use query().`);
    return key[0]!;
  }

  /** The key column and the value to compare it with for `value` — `undefined` when no row can have it, see {@link #key}. */
  async #lookup(value: unknown): Promise<{ readonly column: string; readonly value: unknown } | undefined> {
    const column = await this.#keyColumn();
    const key = await this.#key(column, value);
    return key === undefined ? undefined : { column, value: key };
  }

  /**
   * The value to compare a key column with, or `undefined` when no row can have it: on a uuid column, anything that is no UUID
   * (Postgres would throw `22P02` and a typo in a URL would become a 500), and a UUID in lower case, as SQLite stores it. Other
   * columns, and numbers, pass as they are — without a lookup of the schema.
   */
  async #key(column: string, value: unknown): Promise<unknown> {
    if (typeof value !== 'string') return value;
    if ((await this.#kind(column)) !== 'uuid') return value;
    return UUID.test(value) ? value.toLowerCase() : undefined;
  }

  /** `query` with the relations `names` loaded (`with()`) — names from the code's types, checked against the metadata when it runs. */
  #loading<O>(query: SelectQuery<DB, T, O>, names: readonly string[] | undefined): SelectQuery<DB, T, O> {
    let loading = query as unknown as SelectQuery<any, any, any>;
    for (const name of names ?? []) loading = loading.with(name as never);
    return loading as unknown as SelectQuery<DB, T, O>;
  }

  /**
   * The connection's schema metadata, loaded: a query on this connection loads it (once, on the first of a process or after a
   * schema change).
   */
  async #schema(label: string): Promise<SchemaMetadata> {
    const metadata = metadataOf(this.#db);
    if (!metadata) throw new Error(`${label} needs the app's connection, which knows the schema — this repository runs on one without Marmeon's plugins.`);
    if (!metadata.fresh) await sql`select 1`.execute(this.#db);
    return metadata;
  }

  async #firstWhere(method: string, values: Record<string, unknown>): Promise<RowOf<DB[T]> | undefined> {
    const conditions = Object.entries(values);
    if (conditions.length === 0) throw new TypeError(`${method}() needs at least one column to match — it was given none.`);
    // The names come from the code's types — checked here too, for a cast or an object a request made: never a secret column.
    const metadata = await this.#schema(`${method}()`);
    for (const [column] of conditions) {
      const secret = metadata.secrets.get(this.#name)?.has(column) === true;
      if (secret || metadata.kinds.get(this.#name)?.has(column) !== true) {
        const message = `${method}() compares columns of ${this.#name} that are not secret — ${column} is ${secret ? 'a secret column' : 'not a column of it'}.`;
        throw new TypeError(secret ? withCode('D9', message) : message);
      }
    }
    let query = this.query().selectAll().limit(1) as unknown as SelectQuery<any, any, any>;
    for (const [column, value] of conditions) {
      // A missing value is a mistake (a field the request did not have), never "any value".
      if (value === undefined) {
        throw new TypeError(`${method}() was given no value for ${column} (undefined) — a condition without a value would match any row. Pass null to find a NULL.`);
      }
      query = value === null ? query.where(column, 'is', null) : query.where(column, '=', value);
    }
    return (await query.executeTakeFirst()) as RowOf<DB[T]> | undefined;
  }

  #statics(): RepositoryStatics {
    return this.constructor as unknown as RepositoryStatics;
  }
}

/** What `Route.bind(…, { with })` takes for a repository — the table's relations — and the row it then binds, with them loaded. */
export interface RepositoryBindingWith<DB, T extends keyof DB> extends RouteBindingWith {
  readonly with: readonly RelationName<DB, T>[];
  readonly value: WithRelations<DB, T, this['with'][number]>;
}

/** The columns an index name mentions: `<table>_` and `_unique` taken off, then the longest known column at each place. */
function columnsInName(name: string, table: string, known: readonly string[]): string[] {
  const rest = name.replace(new RegExp(`^${table}_`), '').replace(/_unique$/, '');
  const longestFirst = [...known].sort((a, b) => b.length - a.length);
  const found: string[] = [];
  for (let at = 0; at < rest.length; ) {
    const column = longestFirst.find((candidate) => rest.startsWith(candidate, at) && (rest[at + candidate.length] ?? '_') === '_');
    if (column && !found.includes(column)) found.push(column);
    const next = rest.indexOf('_', at + (column?.length ?? 0));
    at = next === -1 ? rest.length : next + 1;
  }
  return found;
}
