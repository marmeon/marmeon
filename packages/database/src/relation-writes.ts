import type { Connection, NewRowOf, RowOf, RowUpdateOf } from './builder.ts';
import type { Relation } from './introspection.ts';
import type { SchemaMetadata } from './metadata.ts';
import type { Exact } from './repository.ts';
import { fold } from './secret-guard.ts';
import { softDeleteFilter } from './schema-resolver.ts';
import { stampTimestamps } from './timestamps.ts';
import type { Relations } from './types.ts';

// Writing through a relation of one row (`repository.relation(id, name)`): the links of a belongsToMany, the rows of a hasMany or a
// hasOne. Table and column names come from the metadata the foreign keys were derived into, never from the values.

type RelationOf<T, N> = T extends keyof Relations ? (N extends keyof Relations[T] ? Relations[T][N] : never) : never;

/** Whether `DB` lets its user write table `X` — a module's view of another module's table can be read only. */
type CanWrite<DB, X> = X extends keyof DB ? ([keyof RowUpdateOf<DB[X]>] extends [never] ? false : true) : false;

/** A belongsToMany writes its pivot and reads its related table; a hasMany or a hasOne writes its related table. */
type Writes<DB, R> = R extends { readonly kind: 'belongsToMany'; readonly table: infer X; readonly pivot: infer P }
  ? X extends keyof DB
    ? CanWrite<DB, P>
    : false
  : R extends { readonly kind: 'hasMany' | 'hasOne'; readonly table: infer X }
    ? CanWrite<DB, X>
    : false;

/**
 * The relations of table `T` that `relation()` writes through: a belongsToMany, a hasMany or a hasOne — whose tables `DB` lets
 * its user write (a module's own ones). See `docs/queries.md#writing-through-relations`.
 */
export type WritableRelationName<DB, T> = T extends keyof Relations
  ? { [N in keyof Relations[T]]: Writes<DB, Relations[T][N]> extends true ? N : never }[keyof Relations[T]] & string
  : never;

/** The value a belongsToMany's links hold of the related row: its key, usually `id`. */
type TargetKey<DB, R> = R extends { readonly table: infer X extends keyof DB; readonly targetKey: infer K }
  ? K extends keyof RowOf<DB[X]>
    ? RowOf<DB[X]>[K]
    : never
  : never;

/** A new row of a hasMany or a hasOne: what an insert into its table takes, without the foreign key the relation sets. */
type NewRelated<DB, X extends keyof DB, F> = Omit<NewRowOf<DB[X]>, F & string>;

/** The links of one row's belongsToMany. See `docs/queries.md#writing-through-relations`. */
export interface LinkWriter<K> {
  /** Links exactly `ids`: the missing ones are attached, the others detached — in one transaction. */
  sync(ids: readonly K[]): Promise<{ attached: K[]; detached: K[] }>;
  /** Links `ids` that are not linked yet; returns those. A soft-deleted or missing related row is refused, and nothing is written. */
  attach(ids: K | readonly K[]): Promise<K[]>;
  /** Unlinks every one; returns how many links went. */
  detach(): Promise<number>;
  /** Unlinks `ids` (an empty list: none); returns how many links went. `undefined` is refused, never "every one". */
  detach(ids: K | readonly K[]): Promise<number>;
}

/** The rows of one row's hasMany or hasOne. See `docs/queries.md#writing-through-relations`. */
export interface RelatedWriter<DB, X extends keyof DB, F> {
  /** Inserts a related row with the foreign key set, and returns it as stored — without its secret columns. */
  create<V extends NewRelated<DB, X, F>>(values: Exact<V, NewRelated<DB, X, F>>): Promise<RowOf<DB[X]>>;
  /** Inserts the related rows in one transaction, and returns them in their order. */
  createMany<V extends NewRelated<DB, X, F>>(values: readonly Exact<V, NewRelated<DB, X, F>>[]): Promise<RowOf<DB[X]>[]>;
}

/** What `relation(id, name)` writes: the links of a belongsToMany, or the rows of a hasMany or a hasOne. */
export type RelationWriter<DB, T, N> =
  RelationOf<T, N> extends infer R
    ? R extends { readonly kind: 'belongsToMany' }
      ? LinkWriter<TargetKey<DB, R>>
      : R extends { readonly kind: 'hasMany' | 'hasOne'; readonly table: infer X extends keyof DB; readonly foreignKey: infer F }
        ? RelatedWriter<DB, X, F>
        : never
    : never;

/** What the repository gives a relation's writes. */
export interface WriteContext {
  /** The table of the row whose relation is written. */
  readonly table: string;
  readonly name: string;
  /**
   * Runs `work` in a transaction of the repository — with the loaded metadata and a reader of the row's `column` (`undefined` when
   * there is no row, or it is soft-deleted).
   */
  run<R>(work: (db: Connection<any>, key: (column: string) => Promise<{ value: unknown } | undefined>, metadata: SchemaMetadata) => Promise<R>): Promise<R>;
  /** The error for a row that is not there (a 404). */
  missing(): Error;
}

type Kind = Relation['kind'];
type Method = 'sync' | 'attach' | 'detach' | 'create' | 'createMany';

/** The writer `relation(id, name)` returns — every method at runtime; the types offer those of the relation's kind. */
export function relationWriter(context: WriteContext): LinkWriter<unknown> & { create(values: object): Promise<unknown>; createMany(values: readonly object[]): Promise<unknown[]> } {
  const { table, name } = context;
  const label = `relation('${name}')`;

  /** `nothing`: what a write of an empty list answers — after the parent row was found, so a missing one is a 404 either way. */
  const write = <R>(method: Method, work: (db: Connection<any>, relation: Relation, key: unknown, metadata: SchemaMetadata) => Promise<R>, nothing?: { readonly value: R }): Promise<R> =>
    context.run(async (db, key, metadata) => {
      const relation = metadata.relations.get(table)?.get(name);
      if (!relation) {
        const known = [...(metadata.relations.get(table)?.keys() ?? [])];
        throw new Error(`${label}: ${table} has no relation "${name}"${known.length ? ` — it has ${known.join(', ')}` : ''}.`);
      }
      refuseKind(relation.kind, method, table, label, name, relation);
      if (relation.pivot && metadata.softDeletes.has(relation.pivot)) {
        throw new Error(`${label} writes the links in ${relation.pivot}, which has soft deletes — write them with a query of your own.`);
      }
      const row = await key(relation.localKey);
      if (!row) throw context.missing();
      if (nothing) return nothing.value;
      return work(db, relation, row.value, metadata);
    });

  /** The related rows among `ids` that are there and not soft-deleted — the only ones a link may point at. */
  const refuseGone = async (db: Connection<any>, relation: Relation, key: unknown, method: Method, ids: readonly unknown[]) => {
    if (ids.length === 0) return;
    const found = await db.selectFrom(relation.table).select(relation.targetKey).where(relation.targetKey, 'in', ids).where(softDeleteFilter(relation.table)).execute();
    const there = new Set(found.map((target) => same((target as Record<string, unknown>)[relation.targetKey])));
    const gone = ids.filter((id) => !there.has(same(id)));
    if (gone.length > 0) {
      throw new Error(
        `${label}.${method}() would link the ${table} row ${String(key)} to the ${relation.table} ${gone.length > 1 ? 'rows' : 'row'} ${gone.map(String).join(', ')}, ` +
          `which ${gone.length > 1 ? 'are' : 'is'} missing or ` +
          'soft-deleted — nothing was written. Check the ids first: the rule exists() leaves soft-deleted rows out. See docs/queries.md#writing-through-relations.',
      );
    }
  };

  const linked = async (db: Connection<any>, relation: Relation, key: unknown): Promise<unknown[]> =>
    (await db.selectFrom(relation.pivot!).select(relation.relatedKey!).where(relation.foreignKey, '=', key).execute()).map((link) => (link as Record<string, unknown>)[relation.relatedKey!]);

  /** Inserts the links, and returns the ids it linked: a link another transaction made meanwhile is left alone (the pivot is unique). */
  const link = async (db: Connection<any>, relation: Relation, key: unknown, ids: readonly unknown[]): Promise<unknown[]> => {
    if (ids.length === 0) return [];
    // A pivot with `timestamps()` keeps the time of its links: the app's clock, like every row a repository writes.
    const rows = await stampTimestamps(db, relation.pivot!, ids.map((id) => ({ [relation.foreignKey]: key, [relation.relatedKey!]: id })));
    const inserted = await db
      .insertInto(relation.pivot!)
      .values(rows)
      .onConflict((conflict) => conflict.doNothing())
      .returning(relation.relatedKey!)
      .execute();
    const linkedNow = new Set(inserted.map((row) => same((row as Record<string, unknown>)[relation.relatedKey!])));
    return ids.filter((id) => linkedNow.has(same(id)));
  };

  const insert = async (db: Connection<any>, relation: Relation, key: unknown, method: Method, values: object, metadata: SchemaMetadata): Promise<unknown> => {
    // SQLite reads `POST_ID` as `post_id` and keeps the first of two values for one column — the caller's. Postgres tells them apart,
    // so a spelling the table has as a column of its own is left alone.
    const columns = metadata.kinds.get(relation.table);
    const foreign = fold(relation.foreignKey);
    if (Object.keys(values).some((name) => name === relation.foreignKey || (fold(name) === foreign && !columns?.has(name)))) {
      throw new TypeError(`${label}.${method}() sets ${relation.table}.${relation.foreignKey} itself — leave it out of the values.`);
    }
    // `returningAll()` is spelled out without the secret columns by the connection, like every select of all columns.
    const [row] = await stampTimestamps(db, relation.table, [{ ...values, [relation.foreignKey]: key }]);
    return db.insertInto(relation.table).values(row!).returningAll().executeTakeFirstOrThrow();
  };

  return {
    sync: (ids) =>
      write('sync', async (db, relation, key) => {
        const wanted = distinct(ids);
        const current = await linked(db, relation, key);
        const missing = without(wanted, current);
        const detached = without(current, wanted);
        // Refused before anything changes: a sync either happens whole, or not at all.
        await refuseGone(db, relation, key, 'sync', missing);
        const attached = await link(db, relation, key, missing);
        if (detached.length > 0) await db.deleteFrom(relation.pivot!).where(relation.foreignKey, '=', key).where(relation.relatedKey!, 'in', detached).execute();
        return { attached, detached };
      }),
    attach: (ids) =>
      write('attach', async (db, relation, key) => {
        const missing = without(distinct(list(ids)), await linked(db, relation, key));
        await refuseGone(db, relation, key, 'attach', missing);
        return link(db, relation, key, missing);
      }),
    detach: (...given: [] | [unknown]) => {
      const ids = given[0];
      // An ids argument that is undefined (a field a request did not send) is a mistake — never "unlink every one".
      if (given.length > 0 && ids === undefined) {
        return Promise.reject(new TypeError(`${label}.detach() was given undefined — that is no list of ids. Call detach() without an argument to unlink every one.`));
      }
      // An empty list is no list: it unlinks nothing, never everything.
      const only = ids === undefined ? undefined : distinct(list(ids));
      return write(
        'detach',
        async (db, relation, key) => {
          let query = db.deleteFrom(relation.pivot!).where(relation.foreignKey, '=', key);
          if (only !== undefined) query = query.where(relation.relatedKey!, 'in', only);
          return Number((await query.executeTakeFirst()).numDeletedRows);
        },
        only?.length === 0 ? { value: 0 } : undefined,
      );
    },
    create: (values) => write('create', (db, relation, key, metadata) => insert(db, relation, key, 'create', values, metadata)),
    createMany: (values) =>
      write(
        'createMany',
        async (db, relation, key, metadata) => {
          const rows: unknown[] = [];
          // One insert per row: the rows come back in the order they were given (a multi-row RETURNING has no order on SQLite).
          for (const item of values) rows.push(await insert(db, relation, key, 'createMany', item, metadata));
          return rows;
        },
        values.length === 0 ? { value: [] } : undefined,
      ),
  };
}

function refuseKind(kind: Kind, method: Method, table: string, label: string, name: string, relation: Relation): void {
  const links = method === 'sync' || method === 'attach' || method === 'detach';
  if (kind === 'belongsTo') {
    throw new Error(`${label} writes through a hasMany, a hasOne or a belongsToMany — ${name} is a belongsTo of ${table}: set ${relation.foreignKey} with update() instead.`);
  }
  if (links && kind !== 'belongsToMany') throw new Error(`${label}.${method}() links the rows of a belongsToMany — ${name} is a ${kind} of ${table}: use create().`);
  if (!links && kind === 'belongsToMany') throw new Error(`${label}.${method}() adds a row to a hasMany or a hasOne — ${name} is a belongsToMany of ${table}: use attach().`);
}

/** A key as a set compares it: `4` and `'4'` (a form's value) are one key. */
function same(value: unknown): string {
  return String(value);
}

function list<K>(ids: K | readonly K[]): readonly K[] {
  return Array.isArray(ids) ? (ids as readonly K[]) : [ids as K];
}

function distinct<K>(ids: readonly K[]): K[] {
  const seen = new Set<string>();
  return ids.filter((id) => !seen.has(same(id)) && Boolean(seen.add(same(id))));
}

function without<K>(ids: readonly K[], others: readonly unknown[]): K[] {
  const drop = new Set(others.map(same));
  return ids.filter((id) => !drop.has(same(id)));
}
