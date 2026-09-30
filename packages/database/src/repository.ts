import { HttpError, type RouteBinder, type RouteBindingContext } from '@bespokecore/router';
import { sql, type Insertable, type Kysely, type SelectQueryBuilder, type Selectable, type Transaction, type Updateable } from 'kysely';
import { Connections } from './connections.ts';
import { paginate, type Paginated } from './pagination.ts';
import type { Tables } from './types.ts';

/** `findOrFail` found nothing: answers 404 like Laravel's ModelNotFoundException — without telling the client what was looked up. */
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
  /** The table — a runtime value, like `static request` on controllers (E13). */
  readonly table: string;
  /** Default connection name. */
  readonly connection?: string;
  /** Sets `updated_at` on every `update()` (the migration's `timestamps()` fill both on insert). */
  readonly timestamps?: boolean;
  /** `delete()` sets `deleted_at`; reads skip deleted rows unless `withTrashed()`. */
  readonly softDeletes?: boolean;
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
 * Optional base for a table's repository — a Data Mapper: rows in, rows out, no Active Record,
 * no identity map, no lazy loading, no dirty tracking, nothing happens on save that you did not call.
 *
 * ```ts
 * export class UserRepository extends Repository<'users'> {
 *   static table = 'users' as const;
 *   findByEmail(email: string) {
 *     return this.query().selectAll().where('email', '=', email).executeTakeFirst();
 *   }
 * }
 * ```
 *
 * Repositories are ordinary injectable classes: data access only, their only dependency is the
 * connection (that is what lets {@link using} bind one to a transaction).
 */
export abstract class Repository<T extends keyof DB & string, DB = Tables> implements RouteBinder<Selectable<DB[T]>> {
  readonly #db: Kysely<DB>;

  constructor(connections: Connections) {
    const statics = this.#statics();
    if (typeof statics.table !== 'string') {
      throw new TypeError(`${new.target.name} needs its table as a runtime value: static table = '…' as const;`);
    }
    this.#db = connections.get<DB>(statics.connection);
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
   * The same repository, working inside `trx` — for transactions over several repositories:
   *
   * ```ts
   * await db.transaction().execute(async (trx) => {
   *   const user = await this.#users.using(trx).insert({ … });
   *   await this.#activity.using(trx).record(user.id);
   * });
   * ```
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
   * Runs `callback` in a transaction, with this repository bound to it. Inside another transaction
   * (`using(trx)`) it becomes a savepoint — Kysely itself refuses a transaction in a transaction.
   */
  async transaction<R>(callback: (repository: this) => Promise<R>): Promise<R> {
    const db = this.db;
    if (!db.isTransaction) return db.transaction().execute((trx) => callback(this.using(trx)));
    const name = sql.raw(`repository_savepoint_${++savepoints}`);
    await sql`savepoint ${name}`.execute(db);
    try {
      const result = await callback(this);
      await sql`release savepoint ${name}`.execute(db);
      return result;
    } catch (error) {
      await sql`rollback to savepoint ${name}`.execute(db);
      throw error;
    }
  }

  /** A select on the table — soft-deleted rows excluded when the repository uses soft deletes. */
  query(): SelectQueryBuilder<DB, T, {}> {
    const query = this.#untyped.selectFrom(this.#name) as unknown as SelectQueryBuilder<DB, T, {}>;
    return this.#statics().softDeletes ? (query.where('deleted_at' as never, 'is', null) as typeof query) : query;
  }

  /** One page of a query on this repository's connection: `this.paginate(this.query().selectAll().orderBy('id'), { page })`. */
  paginate<TB extends keyof DB, O>(query: SelectQueryBuilder<DB, TB, O>, options: { page?: number; perPage?: number } = {}): Promise<Paginated<O>> {
    return paginate(this.db, query, options);
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

  /** Updates a row and returns it — `undefined` when there is none. Sets `updated_at` with `static timestamps = true`. */
  async update<V extends Updateable<DB[T]>>(id: KeyOf<T, DB>, values: Exact<V, Updateable<DB[T]>>): Promise<Selectable<DB[T]> | undefined> {
    const changes: Record<string, unknown> = this.#statics().timestamps ? { ...values, updated_at: new Date() } : { ...values };
    let query = this.#untyped.updateTable(this.#name).set(changes).where('id', '=', id);
    if (this.#statics().softDeletes) query = query.where('deleted_at', 'is', null);
    return (await query.returningAll().executeTakeFirst()) as Selectable<DB[T]> | undefined;
  }

  /** Deletes a row — with soft deletes, marks it deleted. Returns whether there was one. */
  async delete(id: KeyOf<T, DB>): Promise<boolean> {
    if (this.#statics().softDeletes) {
      const result = await this.#untyped
        .updateTable(this.#name)
        .set({ deleted_at: new Date() })
        .where('id', '=', id)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      return result.numUpdatedRows > 0n;
    }
    return this.forceDelete(id);
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
