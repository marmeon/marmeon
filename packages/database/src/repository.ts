import { err, ok, rollBackOnErr, type Result } from '@marmeon/core';
import { errOfRollback } from '@marmeon/core/internal';
import { HttpError, type RouteBinder, type RouteBindingContext, type RouteBindingWith } from '@marmeon/router';
import { sql, type Insertable, type Kysely, type SelectQueryBuilder, type Selectable, type Transaction, type Updateable } from 'kysely';
import { Connections } from './connections.ts';
import { isUniqueViolation } from './errors.ts';
import type { RelationName, WithRelations } from './chain.ts';
import { keyset, paginate, type CheckPageRequest, type Paginated, type PageRequest } from './pagination.ts';
import { TOUCH_COLUMN } from './placeholders.ts';
import { relationWriter, type RelationWriter, type WritableRelationName } from './relation-writes.ts';
import { metadataOf, softDelete, softDeleteFilter } from './schema-resolver.ts';
import type { ColumnKind, SchemaMetadata } from './metadata.ts';
import type { Tables } from './types.ts';

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

/** The type of a table's `id` column — or `never` for tables without one. */
export type KeyOf<T extends keyof DB, DB = Tables> = Selectable<DB[T]> extends { id: infer K } ? K : never;

/** What a repository class declares statically, next to `extends Repository<'users'>`. */
export interface RepositoryStatics {
  /** The table — a runtime value, like `static request` on controllers. */
  readonly table: string;
  /** Default connection name. */
  readonly connection?: string;
  /** The column a route parameter matches (`Route.bind`) — default `id`. */
  readonly routeKey?: string;
  /**
   * What a route parameter must look like before it is looked up — default: digits for `id`
   * (anything else is a 404 without a query; Postgres would fail comparing a bigint with `'abc'`).
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

/**
 * Optional base for a table's repository — rows in, rows out: no identity map, no lazy loading, no dirty tracking. Declare
 * the table again as a value (`static table = 'users' as const`); the only dependency is the connection, which is what lets
 * {@link using} bind one to a transaction. Soft deletes and timestamps follow the table's migration (`softDeletes()`,
 * `timestamps()`). See `docs/queries.md#repositories`.
 */
export abstract class Repository<T extends keyof DB & string, DB = Tables> implements RouteBinder<Selectable<DB[T]>> {
  /** Types only: `Route.bind('post', PostRepository, { with: ['author'] })` takes the table's relations and types them on the row. */
  declare readonly routeBindingWith?: RepositoryBindingWith<DB, T>;
  readonly #db: Kysely<DB>;
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
  protected get db(): Kysely<DB> {
    return this.#db;
  }

  /** The base class works on a table only known at runtime — typed at its public surface instead. */
  get #untyped(): Kysely<any> {
    return this.#db as Kysely<any>;
  }

  get #name(): string {
    return this.#statics().table;
  }

  /**
   * The same repository, working inside `trx` — explicitly. Inside `connections.transaction(…)` a repository joins the
   * transaction by itself; `using(trx)` is for transactions you control yourself (Kysely's
   * `db.startTransaction()`, a second connection at the same time, code outside the transaction's call chain).
   */
  using(trx: Transaction<DB> | Kysely<DB>): this {
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
  query(): SelectQueryBuilder<DB, T, {}> {
    return this.#untyped.selectFrom(this.#name).where(softDeleteFilter(this.#name)) as unknown as SelectQueryBuilder<DB, T, {}>;
  }

  /**
   * One page of a query on this repository's connection — which page: the route's parsed query (`ctx.query`, with `pageQuery()` in
   * its schema) or `{ page, perPage }`: `this.paginate(this.query().selectAll().orderBy('id'), ctx.query)`.
   */
  paginate<TB extends keyof DB, O, const Q = PageRequest>(query: SelectQueryBuilder<DB, TB, O>, request?: CheckPageRequest<Q>): Promise<Paginated<O>> {
    return paginate(this.db, query, request as PageRequest | undefined);
  }

  /** The row with this `id`, or `undefined`. On a uuid key, an id that is no UUID finds nothing — without a query. */
  async find(id: KeyOf<T, DB>): Promise<Selectable<DB[T]> | undefined> {
    const key = await this.#key('id', id);
    if (key === undefined) return undefined;
    return (await this.query().selectAll().where('id' as never, '=', key as never).executeTakeFirst()) as Selectable<DB[T]> | undefined;
  }

  /**
   * The row, or a 404 (`RecordNotFoundError`) — with the relations `with` names loaded in the same query, as `with()` loads them.
   * See `docs/queries.md#reading`.
   */
  async findOrFail<const W extends readonly RelationName<DB, T>[] = []>(id: KeyOf<T, DB>, options: { readonly with?: W } = {}): Promise<WithRelations<DB, T, W[number]>> {
    const key = await this.#key('id', id);
    const row = key === undefined ? undefined : await this.#loading(this.query().selectAll().where('id' as never, '=', key as never), options.with).executeTakeFirst();
    if (!row) throw new RecordNotFoundError(this.table, id);
    return row as WithRelations<DB, T, W[number]>;
  }

  /**
   * The first row whose `column` holds `value` (`null` finds a NULL) — `undefined` when there is none. Never a soft-deleted one.
   * See `docs/queries.md#reading`.
   */
  findBy<C extends keyof Selectable<DB[T]> & string>(column: C, value: Selectable<DB[T]>[C]): Promise<Selectable<DB[T]> | undefined> {
    return this.#firstWhere('findBy', { [column]: value });
  }

  /** The first row that holds every value of `values` (`null` finds a NULL) — `undefined` when there is none. See `docs/queries.md#reading`. */
  firstWhere<V extends Partial<Selectable<DB[T]>>>(values: Exact<V, Selectable<DB[T]>>): Promise<Selectable<DB[T]> | undefined> {
    return this.#firstWhere('firstWhere', values as Record<string, unknown>);
  }

  /** One column of every row, without the soft-deleted ones. A secret column is refused. See `docs/queries.md#reading`. */
  async pluck<C extends keyof Selectable<DB[T]> & string>(column: C): Promise<Selectable<DB[T]>[C][]> {
    const rows = await this.query().select(column as never).execute();
    return rows.map((row) => (row as Record<string, unknown>)[column]) as Selectable<DB[T]>[C][];
  }

  /**
   * The rows in batches of `size`, by their `id` — no offset: rows added or removed meanwhile neither repeat nor go missing. One query
   * per batch; `query` narrows what is read (conditions, relations). See `docs/queries.md#reading`.
   *
   * ```ts
   * for await (const users of this.chunk(500, (query) => query.where('email_verified_at', 'is', null))) …
   * ```
   */
  async *chunk<O = Selectable<DB[T]>>(
    size: number,
    query?: (query: SelectQueryBuilder<DB, T, Selectable<DB[T]>>) => SelectQueryBuilder<DB, T, O>,
  ): AsyncGenerator<O[], void, undefined> {
    if (!Number.isSafeInteger(size) || size < 1) throw new RangeError(`chunk() takes a size that is a whole number ≥ 1, got ${size}.`);
    const all = this.query().selectAll() as unknown as SelectQueryBuilder<DB, T, Selectable<DB[T]>>;
    const base = query ? query(all) : (all as unknown as SelectQueryBuilder<DB, T, O>);
    // The batches go by id: another order would be dropped without a word.
    if (base.toOperationNode().orderBy) throw new TypeError('chunk() reads the rows in the order of their id — leave orderBy() out of its callback.');
    let after: unknown[] | undefined;
    for (;;) {
      const rows = await keyset(base, [`${this.#name}.id`], after, 'asc', size).execute();
      const last = rows.at(-1) as Record<string, unknown> | undefined;
      if (last && !Object.hasOwn(last, 'id')) throw new TypeError('chunk() reads the rows by their key "id", but the query does not select it — keep it in the selection.');
      if (rows.length > 0) yield rows;
      if (!last || rows.length < size) return;
      after = [last.id];
    }
  }

  async exists(id: KeyOf<T, DB>): Promise<boolean> {
    const key = await this.#key('id', id);
    if (key === undefined) return false;
    const row = await this.query().select(sql<number>`1`.as('found')).where('id' as never, '=', key as never).executeTakeFirst();
    return row !== undefined;
  }

  async count(): Promise<number> {
    const row = await this.query().select(sql<number | string>`count(*)`.as('count')).executeTakeFirstOrThrow();
    return Number((row as { count: number | string }).count);
  }

  /** Inserts a row and returns it as stored — defaults and generated id included. */
  async insert<V extends Insertable<DB[T]>>(values: Exact<V, Insertable<DB[T]>>): Promise<Selectable<DB[T]>> {
    return (await this.#untyped
      .insertInto(this.#name)
      .values(values as Record<string, unknown>)
      .returningAll()
      .executeTakeFirstOrThrow()) as Selectable<DB[T]>;
  }

  /**
   * Inserts a row unless a unique index already holds its values — then an `err` of kind `duplicate` (an e-mail that is taken,
   * say). Race-free, unlike checking first. Runs in a savepoint: on Postgres a failed statement aborts the whole surrounding
   * transaction. Returned from a transaction's callback, the `err` rolls that transaction back. See `docs/queries.md#writing`.
   */
  async tryInsert<V extends Insertable<DB[T]>>(values: Exact<V, Insertable<DB[T]>>): Promise<Result<Selectable<DB[T]>, { kind: 'duplicate' }>> {
    try {
      return ok(await this.transaction((repository) => repository.insert(values)));
    } catch (error) {
      if (isUniqueViolation(error)) return err({ kind: 'duplicate' });
      throw error;
    }
  }

  /**
   * Updates a row unless a unique index already holds the new values — then an `err` of kind `duplicate`; of kind `missing` when
   * there is no such row (or it is soft-deleted). In a savepoint, like `tryInsert`. See `docs/queries.md#writing`.
   */
  async tryUpdate<V extends Updateable<DB[T]>>(
    id: KeyOf<T, DB>,
    values: Exact<V, Updateable<DB[T]>>,
  ): Promise<Result<Selectable<DB[T]>, { kind: 'duplicate' } | { kind: 'missing' }>> {
    try {
      const row = await this.transaction((repository) => repository.update(id, values));
      return row ? ok(row) : err({ kind: 'missing' });
    } catch (error) {
      if (isUniqueViolation(error)) return err({ kind: 'duplicate' });
      throw error;
    }
  }

  /**
   * Writes through a relation of the row `id`: `sync()`, `attach()` and `detach()` the links of a belongsToMany, `create()` and
   * `createMany()` rows of a hasMany or a hasOne with the foreign key set — each in a transaction. A missing or soft-deleted row
   * is a 404 (`RecordNotFoundError`); a link to a missing or soft-deleted related row is refused. See
   * `docs/queries.md#writing-through-relations`.
   */
  relation<N extends WritableRelationName<DB, T>>(id: KeyOf<T, DB>, name: N): RelationWriter<DB, T, N> {
    return relationWriter({
      table: this.#name,
      name,
      missing: () => new RecordNotFoundError(this.table, id),
      run: (work) =>
        this.transaction(async (repository) => {
          const metadata = await repository.#schema(`relation('${name}')`);
          // The row's key, locked on Postgres: a concurrent soft delete of it waits until the links are written.
          const key = async (column: string) => {
            const idKey = await repository.#key('id', id);
            if (idKey === undefined) return undefined;
            let query = repository.query().select(column as never).where('id' as never, '=', idKey as never);
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
  async update<V extends Updateable<DB[T]>>(id: KeyOf<T, DB>, values: Exact<V, Updateable<DB[T]>>): Promise<Selectable<DB[T]> | undefined> {
    const key = await this.#key('id', id);
    if (key === undefined) return undefined;
    return (await this.#untyped
      .updateTable(this.#name)
      .set({ ...(values as Record<string, unknown>), [TOUCH_COLUMN]: new Date() })
      .where('id', '=', key)
      .where(softDeleteFilter(this.#name))
      .returningAll()
      .executeTakeFirst()) as Selectable<DB[T]> | undefined;
  }

  /** Deletes a row — sets `deleted_at` instead when the table's migration called `softDeletes()`. Returns whether there was one. */
  async delete(id: KeyOf<T, DB>): Promise<boolean> {
    const key = await this.#key('id', id);
    if (key === undefined) return false;
    const result = await this.#untyped.deleteFrom(this.#name).where('id', '=', key).where(softDelete(this.#name)).executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  /** Deletes a row for real, soft deletes or not. */
  async forceDelete(id: KeyOf<T, DB>): Promise<boolean> {
    const key = await this.#key('id', id);
    if (key === undefined) return false;
    const result = await this.#untyped.deleteFrom(this.#name).where('id', '=', key).executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  /** Brings a soft-deleted row back. */
  async restore(id: KeyOf<T, DB>): Promise<boolean> {
    const key = await this.#key('id', id);
    if (key === undefined) return false;
    const result = await this.#untyped.updateTable(this.#name).set({ deleted_at: null }).where('id', '=', key).executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  /**
   * `Route.bind('user', UserRepository)`: the row whose route key (`id`) is `value` — within the parent
   * for scoped bindings (`scope.column` = the parent's id), so another parent's row is a 404 — with the relations the binding
   * names (`{ with }`) loaded in the same query. A value that cannot be a key (not digits, not a UUID) is a 404 without a query.
   */
  async resolveRouteBinding(value: string, binding: RouteBindingContext): Promise<Selectable<DB[T]> | undefined> {
    const key = this.#statics().routeKey ?? 'id';
    const custom = this.#statics().routeKeyPattern;
    const kind = await this.#kind(key);
    // The default key is a numeric id: compared as a number (Postgres refuses bigint = text), digits only. A uuid column
    // is compared as the lower-case text SQLite stores, after the format was checked.
    const numericId = key === 'id' && !custom && kind !== 'uuid';
    const pattern = custom ?? (numericId ? /^\d{1,15}$/ : kind === 'uuid' ? UUID : undefined);
    if (pattern && !pattern.test(value)) return undefined;
    const compared = numericId ? Number(value) : kind === 'uuid' ? value.toLowerCase() : value;
    let query = this.#loading(this.query().selectAll(), binding.with).where(key as never, '=', compared as never);
    if (binding.scope) {
      const parent = (binding.scope.parent as { id?: unknown } | undefined)?.id;
      if (parent === undefined) return undefined;
      query = query.where(binding.scope.column as never, '=', parent as never);
    }
    return (await query.executeTakeFirst()) as Selectable<DB[T]> | undefined;
  }

  /**
   * The row whose route key (`static routeKey`, default `id`) is `value`, as a route binding finds it, for lookups outside of
   * routes — `undefined` when there is none, or when `value` cannot be a key. See `docs/queries.md#reading`.
   */
  findByRouteKey(value: string): Promise<Selectable<DB[T]> | undefined> {
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
  #loading<O>(query: SelectQueryBuilder<DB, T, O>, names: readonly string[] | undefined): SelectQueryBuilder<DB, T, O> {
    let loading = query as unknown as SelectQueryBuilder<any, any, any>;
    for (const name of names ?? []) loading = loading.with(name as never);
    return loading as unknown as SelectQueryBuilder<DB, T, O>;
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

  async #firstWhere(method: string, values: Record<string, unknown>): Promise<Selectable<DB[T]> | undefined> {
    const conditions = Object.entries(values);
    if (conditions.length === 0) throw new TypeError(`${method}() needs at least one column to match — it was given none.`);
    // The names come from the code's types — checked here too, for a cast or an object a request made: never a secret column.
    const metadata = await this.#schema(`${method}()`);
    for (const [column] of conditions) {
      const secret = metadata.secrets.get(this.#name)?.has(column) === true;
      if (secret || metadata.kinds.get(this.#name)?.has(column) !== true) {
        throw new TypeError(`${method}() compares columns of ${this.#name} that are not secret — ${column} is ${secret ? 'a secret column' : 'not a column of it'}.`);
      }
    }
    let query = this.query().selectAll().limit(1) as unknown as SelectQueryBuilder<any, any, any>;
    for (const [column, value] of conditions) {
      // A missing value is a mistake (a field the request did not have), never "any value".
      if (value === undefined) {
        throw new TypeError(`${method}() was given no value for ${column} (undefined) — a condition without a value would match any row. Pass null to find a NULL.`);
      }
      query = value === null ? query.where(column, 'is', null) : query.where(column, '=', value);
    }
    return (await query.executeTakeFirst()) as Selectable<DB[T]> | undefined;
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

/** A repository class: `static table` must name the same table as `Repository<'…'>` — checked wherever the class is passed. */
export type RepositoryClass<R extends Repository<any, any> = Repository<any, any>> = (abstract new (...args: any[]) => R) & {
  readonly table: TableOf<R>;
};
/** The table a repository instance is typed for. */
export type TableOf<R> = R extends Repository<infer T, any> ? T : never;
/** The row type a repository reads. */
export type RowOf<R> = R extends Repository<infer T, infer DB> ? Selectable<DB[T]> : never;
