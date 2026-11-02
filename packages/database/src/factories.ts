import { sql, type Selectable } from 'kysely';
import type { Connection, NewRowOf, RowOf } from './builder.ts';
import { Connections } from './connections.ts';
import { metadataOf, nowOf } from './schema-resolver.ts';
import { stampTimestamps } from './timestamps.ts';
import type { Tables } from './types.ts';

/** What a factory definition gets. */
export interface FactoryContext {
  /** Counts the rows this factory made in this app: 1, 2, 3 … */
  readonly sequence: number;
  /**
   * The app's time as its `Clock` reads it, so `app.travel()` moves it as it moves the `created_at` a factory stamps.
   * A new `Date` on each call. See `docs/time.md#what-follows-the-clock`.
   */
  now(): Date;
  /**
   * Another factory, for a foreign key: `user_id: factory(UserFactory)` creates the user when this
   * row is created and uses its id.
   */
  factory<T extends keyof DB & string, DB, S extends string>(definition: FactoryDefinition<T, DB, S>): PendingFactory<T, DB, false, S>;
}

/** A column value in a definition: the value, or another factory whose created row's `id` is used. */
type Attribute<V> = V | PendingFactory<any, any, false>;
/**
 * The row a derived column reads: the other columns' values — a related column holds its created row's id in `create()` and
 * the factory itself in `make()`. A secret column is not in it, so a derived value cannot copy one into a column that is not secret:
 * the type refuses it, and `create()` throws when the function reads one anyway (`make()` has no schema to check against).
 */
export type DerivedRow<Table> = Readonly<{
  [K in keyof Pick<NewRowOf<Table>, keyof NewRowOf<Table> & keyof Selectable<Table>>]: Attribute<NewRowOf<Table>[K]>;
}>;
type Attributes<Row, View> = { [K in keyof Row]: Attribute<Row[K]> | ((row: View) => Attribute<Row[K]>) };
/** What a definition, a state or an override-free `make()` sets: a value, a related factory, or a function of the row (a derived column). */
export type AttributesOf<Table> = Attributes<NewRowOf<Table>, DerivedRow<Table>>;
/**
 * What `make()` gives: the attributes — a related factory's column holds the factory itself, not an id — with what the
 * overrides set as they set it.
 */
export type MadeAttributes<Row, O> = {
  [K in keyof Row]: K extends keyof O ? Exclude<O[K], undefined> | (undefined extends O[K] ? Attribute<Row[K]> : never) : Attribute<Row[K]>;
};
/** An override for a column the table does not have is a compile error (at its key), also next to columns it has. */
type KnownColumns<O, Row> = { [K in Exclude<keyof O, keyof Row>]: never };

/**
 * What `defineFactory()` returns: the table, its default attributes and its named states.
 * See docs/seeding.md#defining-factories.
 */
export interface FactoryDefinition<T extends keyof DB & string, DB = Tables, S extends string = never> {
  readonly table: T;
  readonly definition: (context: FactoryContext) => AttributesOf<DB[T]>;
  readonly states: Readonly<Record<S, Partial<AttributesOf<DB[T]>> | ((context: FactoryContext) => Partial<AttributesOf<DB[T]>>)>>;
}

/**
 * A factory for one table: default values for every required column — typed against the table's
 * insert type, so a new NOT NULL column makes every factory that misses it a compile error.
 * See `docs/seeding.md#defining-factories`.
 */
export function defineFactory<T extends keyof DB & string, DB = Tables, const S extends string = never>(
  table: T,
  // `NoInfer`: with `DB` in the return type, TS would widen a `oneOf()` literal to `string` before `DB` is fixed.
  definition: NoInfer<(context: FactoryContext) => AttributesOf<DB[T]>>,
  options: { states?: Record<S, Partial<AttributesOf<DB[T]>> | NoInfer<(context: FactoryContext) => Partial<AttributesOf<DB[T]>>>> } = {},
): FactoryDefinition<T, DB, S> {
  return Object.freeze({ table, definition, states: options.states ?? ({} as Record<S, never>) });
}

/**
 * Makes rows from factories — per app, so sequences never leak between apps (no global state).
 * Tests use `app.factory(UserFactory)`, seeders the `factory` in their context.
 */
export class Factories {
  readonly #connections: Connections;
  readonly #sequences = new Map<FactoryDefinition<any, any, any>, number>();

  /** @internal Built by the container. */
  constructor(connections: Connections) {
    this.#connections = connections;
  }

  for<T extends keyof DB & string, DB, S extends string>(definition: FactoryDefinition<T, DB, S>): PendingFactory<T, DB, false, S> {
    return new PendingFactory(definition, { factories: this, count: undefined, states: [], db: undefined });
  }

  /** @internal */
  next(definition: FactoryDefinition<any, any, any>): number {
    const sequence = (this.#sequences.get(definition) ?? 0) + 1;
    this.#sequences.set(definition, sequence);
    return sequence;
  }

  /** @internal */
  db(): Connection<any> {
    return this.#connections.get<any>();
  }
}

interface Pending {
  readonly factories: Factories;
  readonly count: number | undefined;
  readonly states: readonly (string | Record<string, unknown>)[];
  readonly db: Connection<any> | undefined;
}

/** One or many rows to make — immutable, each method returns a new one. */
export class PendingFactory<T extends keyof DB & string, DB = Tables, Many extends boolean = false, S extends string = never> {
  readonly #definition: FactoryDefinition<T, DB, S>;
  readonly #pending: Pending;

  /** @internal — made by `factories.for(definition)`. */
  constructor(definition: FactoryDefinition<T, DB, S>, pending: Pending) {
    this.#definition = definition;
    this.#pending = pending;
  }

  /** `count` rows instead of one: `create()` returns an array. */
  count(count: number): PendingFactory<T, DB, true, S> {
    if (!Number.isInteger(count) || count < 0) throw new RangeError(`count() needs a whole number ≥ 0, got ${count}.`);
    return new PendingFactory(this.#definition, { ...this.#pending, count });
  }

  /** A named state from the definition, or attributes: `.state('admin')`, `.state({ is_admin: true })`. */
  state(state: S | Partial<AttributesOf<DB[T]>>): PendingFactory<T, DB, Many, S> {
    if (typeof state === 'string' && !(state in this.#definition.states)) {
      throw new Error(`Factory for "${this.#definition.table}" has no state "${state}". Known: ${Object.keys(this.#definition.states).join(', ') || 'none'}.`);
    }
    return new PendingFactory(this.#definition, { ...this.#pending, states: [...this.#pending.states, state as string | Record<string, unknown>] });
  }

  /** Inside a transaction (or on another connection). */
  using(db: Connection<DB>): PendingFactory<T, DB, Many, S> {
    return new PendingFactory(this.#definition, { ...this.#pending, db: db as Connection<any> });
  }

  /**
   * The attributes, without inserting. Related factories are not created either: their column holds the factory itself, not
   * an id — the type says so (`user_id: number | PendingFactory`), except where `overrides` set the column.
   */
  make<O extends Partial<NewRowOf<DB[T]>> = {}>(
    overrides?: O & KnownColumns<O, NewRowOf<DB[T]>>,
  ): Many extends true ? MadeAttributes<NewRowOf<DB[T]>, O>[] : MadeAttributes<NewRowOf<DB[T]>, O> {
    const rows = this.#times(() => this.#derive(this.#attributes(overrides ?? {})));
    return (this.#pending.count === undefined ? rows[0] : rows) as never;
  }

  /** Inserts and returns the stored rows (defaults and ids included). */
  async create(overrides: Partial<NewRowOf<DB[T]>> = {}): Promise<Many extends true ? RowOf<DB[T]>[] : RowOf<DB[T]>> {
    const db = this.#pending.db ?? this.#pending.factories.db();
    const rows: RowOf<DB[T]>[] = [];
    // The secret columns of the table, known once the schema is loaded.
    const metadata = metadataOf(db);
    if (metadata && !metadata.fresh) await sql`select 1`.execute(db);
    const secrets = metadata?.secrets.get(this.#definition.table);
    // A related factory: create its row first and use its id.
    const settle = async (value: unknown): Promise<unknown> =>
      value instanceof PendingFactory ? ((await (value.#pending.db ? value : value.using(db as never)).create()) as { id: unknown }).id : value;
    for (const attributes of this.#times(() => this.#attributes(overrides))) {
      const values: Record<string, unknown> = {};
      const derived: [string, (row: unknown) => unknown][] = [];
      for (const [column, value] of Object.entries(attributes)) {
        if (typeof value === 'function') derived.push([column, value as never]);
        else values[column] = await settle(value);
      }
      // Derived columns last, in the definition's order: each sees the related rows' ids and the derived columns before it.
      const waiting = new Set(derived.map(([column]) => column));
      for (const [column, derive] of derived) {
        values[column] = await settle(this.#derived(column, derive, values, waiting, secrets));
        waiting.delete(column);
      }
      const [stamped] = await stampTimestamps(db, this.#definition.table, [values]);
      rows.push((await db.insertInto(this.#definition.table).values(stamped!).returningAll().executeTakeFirstOrThrow()) as RowOf<DB[T]>);
    }
    return (this.#pending.count === undefined ? rows[0] : rows) as never;
  }

  /** `make()`'s derived columns: the same order, with related columns still holding their factory. */
  #derive(attributes: Record<string, unknown>): Record<string, unknown> {
    const values: Record<string, unknown> = {};
    const derived: [string, (row: unknown) => unknown][] = [];
    for (const [column, value] of Object.entries(attributes)) {
      if (typeof value === 'function') derived.push([column, value as never]);
      else values[column] = value;
    }
    const waiting = new Set(derived.map(([column]) => column));
    for (const [column, derive] of derived) {
      values[column] = this.#derived(column, derive, values, waiting, undefined);
      waiting.delete(column);
    }
    return values;
  }

  /**
   * Runs one derived column on a read-only view of the row. A column that is derived itself and not yet worked out — this one
   * included — is refused by name instead of reading as `undefined`, which would insert a wrong value for a cycle or a wrong order.
   */
  #derived(column: string, derive: (row: unknown) => unknown, values: Record<string, unknown>, waiting: ReadonlySet<string>, secrets: ReadonlySet<string> | undefined): unknown {
    const table = this.#definition.table;
    const row = new Proxy(Object.freeze(Object.fromEntries(Object.entries(values).filter(([key]) => !secrets?.has(key)))), {
      get(target, key, receiver) {
        if (typeof key === 'string' && secrets?.has(key)) {
          throw new Error(`Factory for "${table}": the derived column "${column}" reads the secret column "${key}". A derived column cannot read a secret column.`);
        }
        if (typeof key === 'string' && waiting.has(key)) {
          throw new Error(
            `Factory for "${table}": the derived column "${column}" reads "${key}", which is derived too and not yet worked out. A derived column can read every column that is not derived, and the derived columns before it.`,
          );
        }
        return Reflect.get(target, key, receiver);
      },
    });
    const value = derive(row);
    if (typeof value === 'function') throw new TypeError(`Factory for "${table}": the derived column "${column}" returned a function; return a value or a factory.`);
    if (value instanceof Promise) {
      value.catch(() => {});
      throw new TypeError(`Factory for "${table}": the derived column "${column}" returned a promise; a derived column is synchronous.`);
    }
    return value;
  }

  #times<R>(make: () => R): R[] {
    return Array.from({ length: this.#pending.count ?? 1 }, make);
  }

  #attributes(overrides: Partial<NewRowOf<DB[T]>>): Record<string, unknown> {
    const { factories } = this.#pending;
    const context: FactoryContext = {
      sequence: factories.next(this.#definition),
      now: () => new Date(nowOf(this.#pending.db ?? factories.db())),
      factory: (definition) => factories.for(definition),
    };
    let attributes: Record<string, unknown> = { ...this.#definition.definition(context) };
    for (const state of this.#pending.states) {
      const values = typeof state === 'string' ? this.#definition.states[state as S] : state;
      attributes = { ...attributes, ...(typeof values === 'function' ? values(context) : values) };
    }
    return { ...attributes, ...overrides };
  }
}
