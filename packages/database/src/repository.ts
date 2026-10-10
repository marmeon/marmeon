import { errOfRollback, rollBackOnErr } from '@marmeon/core';
import { HttpError, type RouteBinder, type RouteBindingContext } from '@marmeon/router';
import { sql, type Insertable, type Kysely, type SelectQueryBuilder, type Selectable, type Transaction, type Updateable } from 'kysely';
import { Connections } from './connections.ts';
import { isUniqueViolation } from './errors.ts';
import { paginate, type CheckPageRequest, type Paginated, type PageRequest } from './pagination.ts';
import { softDelete, softDeleteFilter, TOUCH_COLUMN } from './schema-resolver.ts';
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

  /** A select on the table — without soft-deleted rows when its migration called `softDeletes()`. */
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

  /** Including soft-deleted rows. */
  withTrashed(): SelectQueryBuilder<DB, T, {}> {
    return this.#untyped.selectFrom(this.#name) as unknown as SelectQueryBuilder<DB, T, {}>;
  }

  async find(id: KeyOf<T, DB>): Promise<Selectable<DB[T]> | undefined> {
    return (await this.query().selectAll().where('id' as never, '=', id as never).executeTakeFirst()) as Selectable<DB[T]> | undefined;
  }

  /** The row, or a 404 (`RecordNotFoundError`). */
  async findOrFail(id: KeyOf<T, DB>): Promise<Selectable<DB[T]>> {
    const row = await this.find(id);
    if (!row) throw new RecordNotFoundError(this.table, id);
    return row;
  }

  async exists(id: KeyOf<T, DB>): Promise<boolean> {
    const row = await this.query().select(sql<number>`1`.as('found')).where('id' as never, '=', id as never).executeTakeFirst();
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
   * Inserts a row unless a unique index already holds its values — then `undefined` (an e-mail that is
   * taken, say). Race-free, unlike checking first. Runs in a savepoint: on Postgres a failed statement
   * aborts the whole surrounding transaction, so a plain insert-and-catch would break every query after it.
   */
  async tryInsert<V extends Insertable<DB[T]>>(values: Exact<V, Insertable<DB[T]>>): Promise<Selectable<DB[T]> | undefined> {
    try {
      return await this.transaction((repository) => repository.insert(values));
    } catch (error) {
      if (isUniqueViolation(error)) return undefined;
      throw error;
    }
  }

  /**
   * Updates a row unless a unique index already holds the new values — then `'duplicate'`; `undefined`
   * when there is no such row. In a savepoint, like `tryInsert`.
   */
  async tryUpdate<V extends Updateable<DB[T]>>(id: KeyOf<T, DB>, values: Exact<V, Updateable<DB[T]>>): Promise<Selectable<DB[T]> | undefined | 'duplicate'> {
    try {
      return await this.transaction((repository) => repository.update(id, values));
    } catch (error) {
      if (isUniqueViolation(error)) return 'duplicate';
      throw error;
    }
  }

  /**
   * Updates a row and returns it — `undefined` when there is none (or it is soft-deleted). Sets `updated_at` when the
   * table's migration called `timestamps()`, unless `values` set it.
   */
  async update<V extends Updateable<DB[T]>>(id: KeyOf<T, DB>, values: Exact<V, Updateable<DB[T]>>): Promise<Selectable<DB[T]> | undefined> {
    return (await this.#untyped
      .updateTable(this.#name)
      .set({ ...(values as Record<string, unknown>), [TOUCH_COLUMN]: new Date() })
      .where('id', '=', id)
      .where(softDeleteFilter(this.#name))
      .returningAll()
      .executeTakeFirst()) as Selectable<DB[T]> | undefined;
  }

  /** Deletes a row — sets `deleted_at` instead when the table's migration called `softDeletes()`. Returns whether there was one. */
  async delete(id: KeyOf<T, DB>): Promise<boolean> {
    const result = await this.#untyped.deleteFrom(this.#name).where('id', '=', id).where(softDelete(this.#name)).executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  /** Deletes a row for real, soft deletes or not. */
  async forceDelete(id: KeyOf<T, DB>): Promise<boolean> {
    const result = await this.#untyped.deleteFrom(this.#name).where('id', '=', id).executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  /** Brings a soft-deleted row back. */
  async restore(id: KeyOf<T, DB>): Promise<boolean> {
    const result = await this.#untyped.updateTable(this.#name).set({ deleted_at: null }).where('id', '=', id).executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  /**
   * `Route.bind('user', UserRepository)`: the row whose route key (`id`) is `value` — within the parent
   * for scoped bindings (`scope.column` = the parent's id), so another parent's row is a 404.
   */
  async resolveRouteBinding(value: string, binding: RouteBindingContext): Promise<Selectable<DB[T]> | undefined> {
    const key = this.#statics().routeKey ?? 'id';
    const custom = this.#statics().routeKeyPattern;
    // The default key is a numeric id: compared as a number (Postgres refuses bigint = text), digits only.
    const numericId = key === 'id' && !custom;
    const pattern = custom ?? (numericId ? /^\d{1,15}$/ : undefined);
    if (pattern && !pattern.test(value)) return undefined;
    let query = this.query().selectAll().where(key as never, '=', (numericId ? Number(value) : value) as never);
    if (binding.scope) {
      const parent = (binding.scope.parent as { id?: unknown } | undefined)?.id;
      if (parent === undefined) return undefined;
      query = query.where(binding.scope.column as never, '=', parent as never);
    }
    return (await query.executeTakeFirst()) as Selectable<DB[T]> | undefined;
  }

  #statics(): RepositoryStatics {
    return this.constructor as unknown as RepositoryStatics;
  }
}

/** A repository class: `static table` must name the same table as `Repository<'…'>` — checked wherever the class is passed. */
export type RepositoryClass<R extends Repository<any, any> = Repository<any, any>> = (abstract new (...args: any[]) => R) & {
  readonly table: TableOf<R>;
};
/** The table a repository instance is typed for. */
export type TableOf<R> = R extends Repository<infer T, any> ? T : never;
/** The row type a repository reads. */
export type RowOf<R> = R extends Repository<infer T, infer DB> ? Selectable<DB[T]> : never;
