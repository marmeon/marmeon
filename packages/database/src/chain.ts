import { expressionBuilder, type Selectable, type SelectQueryBuilder, type Simplify } from 'kysely';
import { relationCondition, relationSelection } from './relations.ts';
import { withTrashed as withTrashedFilter } from './schema-resolver.ts';
import type { Relations } from './types.ts';

// The relation methods of the query builder: declared on Kysely's `SelectQueryBuilder` interface, and put on the prototype every
// select builder of Kysely's shares — the connection's, a transaction's, a subquery's. They only add placeholders; the
// connection's plugins resolve them (see `SchemaResolver`).

/** Whether `DB` has every table relation `R` reads: its related table, and a belongsToMany's pivot. */
type Sees<DB, R> = R extends { readonly table: infer T } ? (T extends keyof DB ? (R extends { readonly pivot: infer P } ? (P extends keyof DB ? true : false) : true) : false) : false;

/** The names of table `T`'s relations whose tables `DB` has — a module's `Database<'…'>` leaves out the others. */
type NamesOf<DB, T> = T extends keyof Relations ? { [N in keyof Relations[T]]: Sees<DB, Relations[T][N]> extends true ? N : never }[keyof Relations[T]] & string : never;

/** The relations of table `T` that hold a list (hasMany, belongsToMany) — what `withCount()` counts. */
type ListNamesOf<DB, T> = T extends keyof Relations
  ? { [N in keyof Relations[T]]: Relations[T][N] extends { readonly kind: 'hasMany' | 'belongsToMany' } ? (Sees<DB, Relations[T][N]> extends true ? N : never) : never }[keyof Relations[T]] & string
  : never;

/**
 * The relations `with()` can load on a query of the tables `TB`: those of each table whose related table the database can see,
 * and only names a single one of the tables has. See `docs/queries.md#relations`.
 */
export type RelationName<DB, TB extends keyof DB> = { [T in TB]: Exclude<NamesOf<DB, T>, NamesOf<DB, Exclude<TB, T>>> }[TB];

type RelationOf<TB, N> = { [T in TB & keyof Relations]: N extends keyof Relations[T] ? Relations[T][N] : never }[TB & keyof Relations];
type TargetOf<DB, TB, N> = RelationOf<TB, N> extends { readonly table: infer R extends keyof DB } ? R : never;

/** What one row of a relation holds: every column but the secret ones — unless the callback selects columns of the table itself. */
type Loaded<DB, T extends keyof DB, O> = Simplify<[Extract<keyof O, keyof Selectable<DB[T]>>] extends [never] ? Selectable<DB[T]> & O : O>;
type Shaped<R, V> = R extends { readonly kind: 'hasMany' | 'belongsToMany' } ? V[] : R extends { readonly nullable: false } ? V : V | null;
type WithResult<DB, TB extends keyof DB, N, O> = Shaped<RelationOf<TB, N>, Loaded<DB, TargetOf<DB, TB, N>, O>>;

/**
 * A row of table `T` with the relations `N` loaded as `with(name)` loads them — what `findOrFail(id, { with })` and a route binding
 * with `with` give. See `docs/queries.md#reading`.
 */
export type WithRelations<DB, T extends keyof DB, N> = [N] extends [never] ? Selectable<DB[T]> : Simplify<Selectable<DB[T]> & { [K in N & string]: WithResult<DB, T, K, {}> }>;

/** A relation's query, as its callback gets it: the related table only. */
type RelationQuery<DB, T extends keyof DB> = SelectQueryBuilder<DB, T, {}>;

/**
 * A relation no foreign key describes, for `withRelation()`: the rows of `table` whose `foreignKey` holds the outer row's
 * `localKey` (default `id`) — a list, or with `one: true` the first row or `null`. See `docs/queries.md#relations-without-a-foreign-key`.
 */
export interface RelationDefinition<DB, TB extends keyof DB, T extends keyof DB, One extends boolean> {
  readonly table: T;
  readonly foreignKey: keyof DB[T] & string;
  /** A column of the query's tables — of the first one that has it (default `id`). Written out, so a wrong name's message lists the columns. */
  readonly localKey?: { [K in TB]: keyof DB[K] & string }[TB];
  readonly one?: One;
}

declare module 'kysely' {
  interface SelectQueryBuilder<DB, TB extends keyof DB, O> {
    // The name list is written out, not an alias: a wrong name's message then lists the right ones.
    /**
     * Loads a relation derived from the foreign keys into the same query, under its name: every column but the secret ones; soft-deleted
     * rows left out. The callback narrows, orders and nests it; `{ as }` renames it. See `docs/queries.md#relations`.
     */
    with<N extends { [T in TB]: Exclude<NamesOf<DB, T>, NamesOf<DB, Exclude<TB, T>>> }[TB]>(name: N): SelectQueryBuilder<DB, TB, O & { [K in N]: WithResult<DB, TB, N, {}> }>;
    with<N extends { [T in TB]: Exclude<NamesOf<DB, T>, NamesOf<DB, Exclude<TB, T>>> }[TB], O2>(
      name: N,
      callback: (query: RelationQuery<DB, TargetOf<DB, TB, N>>) => SelectQueryBuilder<any, any, O2>,
    ): SelectQueryBuilder<DB, TB, O & { [K in N]: WithResult<DB, TB, N, O2> }>;
    with<N extends { [T in TB]: Exclude<NamesOf<DB, T>, NamesOf<DB, Exclude<TB, T>>> }[TB], const A extends string, O2 = {}>(
      name: N,
      options: { readonly as: A },
      callback?: (query: RelationQuery<DB, TargetOf<DB, TB, N>>) => SelectQueryBuilder<any, any, O2>,
    ): SelectQueryBuilder<DB, TB, O & { [K in A]: WithResult<DB, TB, N, O2> }>;

    /**
     * Loads rows of `table` that no foreign key relates — like `with()`, under `name`: the rows whose `foreignKey` holds the outer
     * row's `localKey`, as a list, or the first one (or `null`) with `one: true`. See `docs/queries.md#relations-without-a-foreign-key`.
     */
    withRelation<const A extends string, T extends keyof DB & string, O2 = {}, const One extends boolean = false>(
      name: A,
      definition: RelationDefinition<DB, TB, T, One>,
      callback?: (query: RelationQuery<DB, T>) => SelectQueryBuilder<any, any, O2>,
    ): SelectQueryBuilder<DB, TB, O & { [K in A]: One extends true ? Loaded<DB, T, O2> | null : Loaded<DB, T, O2>[] }>;

    /**
     * Counts the rows of a list relation (hasMany, belongsToMany) in the same query, as a number under `<name>_count` — or `{ as }`.
     * Soft-deleted rows are not counted; the callback narrows what is. See `docs/queries.md#counting-related-rows`.
     */
    withCount<N extends { [T in TB]: Exclude<ListNamesOf<DB, T>, NamesOf<DB, Exclude<TB, T>>> }[TB]>(
      name: N,
      callback?: (query: RelationQuery<DB, TargetOf<DB, TB, N>>) => SelectQueryBuilder<any, any, any>,
    ): SelectQueryBuilder<DB, TB, O & { [K in `${N}_count`]: number }>;
    withCount<N extends { [T in TB]: Exclude<ListNamesOf<DB, T>, NamesOf<DB, Exclude<TB, T>>> }[TB], const A extends string>(
      name: N,
      options: { readonly as: A },
      callback?: (query: RelationQuery<DB, TargetOf<DB, TB, N>>) => SelectQueryBuilder<any, any, any>,
    ): SelectQueryBuilder<DB, TB, O & { [K in A]: number }>;

    /**
     * Keeps the rows that have a related row (`exists`) — one the callback's conditions match, if it has any; soft-deleted related
     * rows do not count. See `docs/queries.md#filtering-by-relations`.
     */
    whereHas<N extends { [T in TB]: Exclude<NamesOf<DB, T>, NamesOf<DB, Exclude<TB, T>>> }[TB]>(
      name: N,
      callback?: (query: RelationQuery<DB, TargetOf<DB, TB, N>>) => SelectQueryBuilder<any, any, any>,
    ): SelectQueryBuilder<DB, TB, O>;

    /** Keeps the rows that have no related row (`not exists`) — like {@link whereHas}. See `docs/queries.md#filtering-by-relations`. */
    whereDoesntHave<N extends { [T in TB]: Exclude<NamesOf<DB, T>, NamesOf<DB, Exclude<TB, T>>> }[TB]>(
      name: N,
      callback?: (query: RelationQuery<DB, TargetOf<DB, TB, N>>) => SelectQueryBuilder<any, any, any>,
    ): SelectQueryBuilder<DB, TB, O>;

    /**
     * Keeps the soft-deleted rows at this level of the query: a repository's `query()`, or a relation in its callback. See
     * `docs/queries.md#soft-deleted-rows`.
     */
    withTrashed(): SelectQueryBuilder<DB, TB, O>;
  }
}

type Builder = SelectQueryBuilder<any, any, any>;
type Callback = (query: Builder) => unknown;

const methods = {
  with(this: Builder, name: string, second?: { readonly as?: string } | Callback, third?: Callback) {
    const options = typeof second === 'object' && second !== null ? second : {};
    const callback = typeof second === 'function' ? second : third;
    return this.select(relationSelection({ kind: 'with', name }, options.as ?? name, callback) as never);
  },
  withCount(this: Builder, name: string, second?: { readonly as?: string } | Callback, third?: Callback) {
    const options = typeof second === 'object' && second !== null ? second : {};
    const callback = typeof second === 'function' ? second : third;
    return this.select(relationSelection({ kind: 'with', name, use: 'count' }, options.as ?? `${name}_count`, callback) as never);
  },
  whereHas(this: Builder, name: string, callback?: Callback) {
    return this.where(relationCondition({ kind: 'with', name, use: 'exists' }, callback));
  },
  whereDoesntHave(this: Builder, name: string, callback?: Callback) {
    return this.where(relationCondition({ kind: 'with', name, use: 'missing' }, callback));
  },
  withRelation(this: Builder, name: string, definition: { table: string; foreignKey: string; localKey?: string; one?: boolean }, callback?: Callback) {
    const { table, foreignKey, localKey = 'id', one = false } = definition;
    return this.select(relationSelection({ kind: 'relation', name, table, foreignKey, localKey, one }, name, callback) as never);
  },
  withTrashed(this: Builder) {
    return this.where(withTrashedFilter());
  },
};

let installed = false;

/**
 * Puts the relation methods on the prototype Kysely's select builders share — reached through a builder of the public API.
 * Throws when Kysely's builder has a method of the same name: a Kysely update must not silently replace one or the other.
 */
export function installChain(): void {
  if (installed) return;
  installOn(Object.getPrototypeOf(expressionBuilder<any, any>().selectFrom('installChain' as never)) as object);
  installed = true;
}

/** Marks the methods as ours — another copy of this module (two versions of the package on one Kysely) leaves them in place. */
const OWN = Symbol.for('@marmeon/database:relation-method');
for (const method of Object.values(methods)) Object.defineProperty(method, OWN, { value: true });

/** @internal — puts the methods on `prototype`, or throws when it has one of their names that is not ours. */
export function installOn(prototype: object): void {
  const existing = (name: string) => (prototype as Record<string, unknown>)[name] as { [OWN]?: boolean } | undefined;
  for (const name of Object.keys(methods)) {
    if (name in prototype && existing(name)?.[OWN] !== true) {
      throw new Error(`Kysely's select builder has a "${name}" method of its own — @marmeon/database cannot add its relation method of that name.`);
    }
  }
  for (const [name, method] of Object.entries(methods)) {
    if (!(name in prototype)) Object.defineProperty(prototype, name, { value: method, configurable: true, writable: true, enumerable: false });
  }
}

// Wherever the types offer the methods, they exist: also on a Kysely the app's `Connections` did not make (a test's own).
installChain();
