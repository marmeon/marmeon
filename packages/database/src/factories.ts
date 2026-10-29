import type { Connection, NewRowOf, RowOf } from './builder.ts';
import { Connections } from './connections.ts';
import { nowOf } from './schema-resolver.ts';
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
type Attributes<Row> = { [K in keyof Row]: Attribute<Row[K]> };
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
  readonly definition: (context: FactoryContext) => Attributes<NewRowOf<DB[T]>>;
  readonly states: Readonly<Record<S, Partial<NewRowOf<DB[T]>> | ((context: FactoryContext) => Partial<NewRowOf<DB[T]>>)>>;
}

/**
 * A factory for one table: default values for every required column — typed against the table's
 * insert type, so a new NOT NULL column makes every factory that misses it a compile error.
 * See `docs/seeding.md#defining-factories`.
 */
export function defineFactory<T extends keyof DB & string, DB = Tables, const S extends string = never>(
  table: T,
  // `NoInfer`: with `DB` in the return type, TS would widen a `oneOf()` literal to `string` before `DB` is fixed.
  definition: NoInfer<(context: FactoryContext) => Attributes<NewRowOf<DB[T]>>>,
  options: { states?: Record<S, Partial<NewRowOf<DB[T]>> | NoInfer<(context: FactoryContext) => Partial<NewRowOf<DB[T]>>>> } = {},
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
  state(state: S | Partial<NewRowOf<DB[T]>>): PendingFactory<T, DB, Many, S> {
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
    const rows = this.#times(() => this.#attributes(overrides ?? {}));
    return (this.#pending.count === undefined ? rows[0] : rows) as never;
  }

  /** Inserts and returns the stored rows (defaults and ids included). */
  async create(overrides: Partial<NewRowOf<DB[T]>> = {}): Promise<Many extends true ? RowOf<DB[T]>[] : RowOf<DB[T]>> {
    const db = this.#pending.db ?? this.#pending.factories.db();
    const rows: RowOf<DB[T]>[] = [];
    for (const attributes of this.#times(() => this.#attributes(overrides))) {
      const values: Record<string, unknown> = {};
      for (const [column, value] of Object.entries(attributes)) {
        // A related factory: create its row first and use its id.
        if (value instanceof PendingFactory) {
          const related = (await (value.#pending.db ? value : value.using(db as never)).create()) as { id: unknown };
          values[column] = related.id;
        } else {
          values[column] = value;
        }
      }
      const [stamped] = await stampTimestamps(db, this.#definition.table, [values]);
      rows.push((await db.insertInto(this.#definition.table).values(stamped!).returningAll().executeTakeFirstOrThrow()) as RowOf<DB[T]>);
    }
    return (this.#pending.count === undefined ? rows[0] : rows) as never;
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
