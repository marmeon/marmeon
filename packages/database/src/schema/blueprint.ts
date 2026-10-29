import { sql, type ColumnDefinitionBuilder, type CreateTableBuilder, type Expression, type RawBuilder } from 'kysely';

/** What Kysely accepts as a column type (the type itself is not exported). */
type DataTypeExpression = Parameters<CreateTableBuilder<string, never>['addColumn']>[1];

export type Driver = 'sqlite' | 'pgsql';

type OnDelete = 'cascade' | 'set null' | 'restrict' | 'no action';

/** What a column is, independent of the dialect — compiled by {@link Blueprint} for the connection's driver. */
interface ColumnSpec {
  readonly name: string;
  /** The table the column is added to (the name of its check constraint). */
  readonly table: string;
  readonly type: Record<Driver, DataTypeExpression>;
  nullable: boolean;
  primary: boolean;
  identity: boolean;
  unique: boolean;
  secret: boolean;
  default?: { value: unknown } | { now: true } | { uuidv7: true };
  /** The list `oneOf()` holds the column to. */
  oneOf?: readonly string[];
  references?: { table: string; column: string; onDelete?: OnDelete; inverse?: string };
}

/** The column descriptions of blueprints that are closed. */
const closedSpecs = new WeakSet<ColumnSpec>();

/** The error of a change to a plan after `up()` or `down()` returned. */
export function closedPlan(): Error {
  return new Error(
    'The plan of this migration is closed: up() and down() build it synchronously, and a call that comes later (from a schema.data() callback, or after an await) would not be part of it. ' +
      'Add the step in up() itself. See docs/migrations.md#changing-the-data.',
  );
}

/** What a migration declares about a table beyond its columns — kept by the migrator, read by the connection. */
export type TableMarker = 'soft_deletes' | 'timestamps';

/**
 * One column, fluently: `table.string('email').unique()`. Columns are NOT NULL unless marked
 * `nullable()` (unlike SQL's default). `T` is the column's value type, so a default is
 * checked against it.
 */
export class Column<T> {
  readonly #spec: ColumnSpec;

  /** @internal — columns come from the {@link Blueprint}'s methods. */
  constructor(spec: ColumnSpec) {
    this.#spec = spec;
  }

  /** @internal — the column's description, for the modifiers; once the plan is closed it is not to be changed. */
  protected get spec(): ColumnSpec {
    if (closedSpecs.has(this.#spec)) throw closedPlan();
    return this.#spec;
  }

  nullable(): Column<T | null> {
    this.spec.nullable = true;
    return this as Column<T | null>;
  }

  /**
   * Holds the column to a list: a check constraint named `{table}_{column}_check` in the database, and the union of the values as the
   * column's type in `Row<…>`. Only for a `string()` or `text()` column. Every value is a string of 1 to 255 characters without a backslash, none twice. A NULL passes (the column is
   * `nullable()` or it is not). Changing the list later is `dropCheck()` and `check()` on Postgres; SQLite needs raw SQL.
   * See `docs/migrations.md#check-constraints`.
   */
  oneOf<const V extends T & string>(...values: V[]): Column<V | Extract<T, null>> {
    const name = this.#spec.name;
    if (!/^(varchar|text)\b/.test(String(this.#spec.type.sqlite))) throw new Error(`oneOf() on "${name}" works on a string() or text() column only.`);
    if (!values.length) throw new Error(`oneOf() on "${name}" needs at least one value.`);
    if (this.#spec.oneOf) throw new Error(`oneOf() on "${name}" is called twice.`);
    for (const value of values) {
      if (typeof value !== 'string' || value === '' || value.length > 255 || value.includes('\0') || value.includes('\\')) {
        throw new Error(`oneOf() on "${name}" takes strings of 1 to 255 characters without a NUL character or a backslash; got ${JSON.stringify(value)}.`);
      }
    }
    if (new Set(values).size !== values.length) throw new Error(`oneOf() on "${name}" lists a value twice.`);
    this.spec.oneOf = Object.freeze([...values]);
    return this as unknown as Column<V | Extract<T, null>>;
  }

  /** A unique index on this column, named `{table}_{column}_unique` (droppable with `dropUnique`). */
  unique(): this {
    this.spec.unique = true;
    return this;
  }

  primary(): this {
    this.spec.primary = true;
    return this;
  }

  default(value: T): this {
    this.spec.default = { value };
    return this;
  }

  /**
   * Never read by accident (a password hash, a 2FA secret): left out of `Row<…>` and removed from
   * every `selectAll()` / `returningAll()` result. Read it with `secret(eb, 'password')`.
   */
  secret(): this {
    this.spec.secret = true;
    return this;
  }
}

/** A timestamp column; `useCurrent()` defaults it to the time of the insert. */
export class TimestampColumn<T> extends Column<T> {
  useCurrent(): this {
    this.spec.default = { now: true };
    return this;
  }
}

/**
 * The SQLite default of a UUIDv7 column, a plain SQL expression (no function the app has to register): the first 48 bits are
 * the time in milliseconds, then version `7`, variant `8`..`b` and random bits, in the lower-case form `8-4-4-4-12`.
 * See `docs/migrations.md#uuid-keys`.
 */
export const UUIDV7_SQLITE =
  "(substr(printf('%012x', cast(unixepoch('subsec') * 1000 as integer)), 1, 8) || '-' || substr(printf('%012x', cast(unixepoch('subsec') * 1000 as integer)), 9, 4)" +
  " || '-7' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (random() & 3), 1) || substr(lower(hex(randomblob(2))), 2)" +
  " || '-' || lower(hex(randomblob(6))))";

/**
 * The Postgres default of a UUIDv7 column: a random UUID whose first 6 bytes are replaced by the time in milliseconds and whose
 * version bits are set to `7`. It needs Postgres 13 (`gen_random_uuid()`), not 18. See `docs/migrations.md#uuid-keys`.
 */
export const UUIDV7_PGSQL =
  "(encode(set_bit(set_bit(overlay(uuid_send(gen_random_uuid()) placing substring(int8send(floor(extract(epoch from clock_timestamp()) * 1000)::bigint) from 3) from 1 for 6), 52, 1), 53, 1), 'hex')::uuid)";

/** A `uuid` column; `useUuidv7()` has the database generate a time-ordered UUID when an insert gives none. */
export class UuidColumn<T> extends Column<T> {
  /** Default: a version 7 UUID made by the database itself, so it holds for every way of inserting. See `docs/migrations.md#uuid-keys`. */
  useUuidv7(): this {
    this.spec.default = { uuidv7: true };
    return this;
  }
}

/** The regular English plural: `category` → `categories`, `status` → `statuses`, `box` → `boxes`, `key` → `keys`. */
function pluralTable(singular: string): string {
  if (/[^aeiou]y$/i.test(singular)) return `${singular.slice(0, -1)}ies`;
  if (/(?:s|x|z|ch|sh)$/i.test(singular)) return `${singular}es`;
  return `${singular}s`;
}

/** A foreign key column (`foreignId`); `constrained()` adds the reference. */
export class ForeignIdColumn<T> extends Column<T> {
  /**
   * References `table.column` — by default the table named after the column, in the English plural (`user_id` → `users`,
   * `category_id` → `categories`), and its `id`. Irregular words need the table named: `constrained('people')`.
   */
  constrained(table = pluralTable(this.spec.name.replace(/_id$/, '')), column = 'id'): ConstrainedColumn<T> {
    this.spec.references = { table, column };
    return new ConstrainedColumn<T>(this.spec);
  }
}

/** A foreign key with its reference — now it can say what happens when the referenced row is deleted. */
export class ConstrainedColumn<T> extends Column<T> {
  cascadeOnDelete(): this {
    return this.#onDelete('cascade');
  }
  nullOnDelete(): this {
    return this.#onDelete('set null');
  }
  restrictOnDelete(): this {
    return this.#onDelete('restrict');
  }
  /**
   * Names the relation the referenced table gets back (default: this table's name) — needed when a table has two foreign keys
   * to the same table: `.inverse('edited_posts')`. See `docs/migrations.md#relations-from-foreign-keys`.
   */
  inverse(name: string): this {
    if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`inverse('${name}') on "${this.spec.name}": a relation name is snake_case, like a table's.`);
    this.spec.references!.inverse = name;
    return this;
  }
  #onDelete(action: OnDelete): this {
    this.spec.references!.onDelete = action;
    return this;
  }
}

type IndexSpec = { readonly columns: readonly string[]; readonly unique: boolean; readonly name: string };

/** What a {@link Blueprint} holds about its table; the migrator's plan reads it through {@link blueprintParts}. */
interface BlueprintParts {
  /** Columns to add (create, or alter). */
  readonly columns: ColumnSpec[];
  readonly indexes: IndexSpec[];
  readonly drops: string[];
  readonly dropIndexes: string[];
  readonly renames: { from: string; to: string }[];
  /** Existing columns that become NOT NULL (`nullable: false`) or nullable (`nullable: true`). */
  readonly nullability: { column: string; nullable: boolean }[];
  /** Columns taken out of use (`retire()`): the projection forgets them, the database keeps them. */
  readonly retirements: string[];
  /** Named check constraints to add (`check()`). */
  readonly checks: { name: string; sql: string }[];
  /** Check constraints to drop by name (`dropCheck()`). */
  readonly dropChecks: string[];
  /** `timestamps()` and `softDeletes()` were called. */
  readonly markers: Set<TableMarker>;
  /** `notPivot()` was called. */
  notPivot: boolean;
}

let partsOf: (blueprint: Blueprint) => BlueprintParts;

/** What a blueprint holds, for the plan and the projection. Not exported by the package: a migration reaches a table through the methods of `Blueprint` only. */
export function blueprintParts(blueprint: Blueprint): BlueprintParts {
  return partsOf(blueprint);
}

/**
 * Describes a table's columns, indexes and foreign keys, and compiles them for SQLite or Postgres.
 * The declared types are chosen so the type generator (and the SQLite adapter) recognize them:
 * `boolean`, `json`, `datetime`/`timestamptz` stay recognizable on both drivers.
 */
export class Blueprint {
  readonly table: string;

  readonly #parts: BlueprintParts = {
    columns: [],
    indexes: [],
    drops: [],
    dropIndexes: [],
    renames: [],
    nullability: [],
    retirements: [],
    checks: [],
    dropChecks: [],
    markers: new Set(),
    notPivot: false,
  };
  #sealed = false;

  static {
    partsOf = (blueprint) => blueprint.#parts;
  }

  /** @internal — a blueprint is handed to the callback of `schema.create()` and `schema.alter()`. */
  constructor(table: string) {
    this.table = table;
  }

  /** Auto-incrementing big integer primary key. */
  id(name = 'id'): Column<number> {
    return new Column<number>(this.#spec(name, { sqlite: 'integer', pgsql: 'bigint' }, { primary: true, identity: true }));
  }

  string(name: string, length = 255): Column<string> {
    return this.#add(name, { sqlite: `varchar(${length})` as DataTypeExpression, pgsql: `varchar(${length})` as DataTypeExpression });
  }

  text(name: string): Column<string> {
    return this.#add(name, { sqlite: 'text', pgsql: 'text' });
  }

  integer(name: string): Column<number> {
    return this.#add(name, { sqlite: 'integer', pgsql: 'integer' });
  }

  /** Read back as `number` (values beyond 2^53 throw instead of rounding). */
  bigInteger(name: string): Column<number> {
    return this.#add(name, { sqlite: 'integer', pgsql: 'bigint' });
  }

  float(name: string): Column<number> {
    return this.#add(name, { sqlite: 'real', pgsql: 'double precision' });
  }

  /** Exact decimal — read back as a `string`, so no precision is lost. */
  decimal(name: string, precision = 8, scale = 2): Column<string> {
    const type = `numeric(${precision}, ${scale})` as DataTypeExpression;
    return this.#add(name, { sqlite: type, pgsql: type });
  }

  boolean(name: string): Column<boolean> {
    return this.#add(name, { sqlite: 'boolean', pgsql: 'boolean' });
  }

  /** JSON (`jsonb` on Postgres). Defaults are given as values: `.default({})`. */
  json(name: string): Column<unknown> {
    return this.#add(name, { sqlite: 'json', pgsql: 'jsonb' });
  }

  /** Values are 36-character strings; `useUuidv7()` lets the database generate them. */
  uuid(name: string): UuidColumn<string> {
    return new UuidColumn<string>(this.#spec(name, { sqlite: 'uuid' as DataTypeExpression, pgsql: 'uuid' as DataTypeExpression }));
  }

  /** A UUIDv7 primary key made by the database: shorthand for `uuid(name).primary().useUuidv7()`. */
  uuidId(name = 'id'): Column<string> {
    return this.uuid(name).primary().useUuidv7();
  }

  binary(name: string): Column<Uint8Array> {
    return this.#add(name, { sqlite: 'blob', pgsql: 'bytea' });
  }

  /** A calendar date, read back as `YYYY-MM-DD`. */
  date(name: string): Column<string> {
    return this.#add(name, { sqlite: 'date', pgsql: 'date' });
  }

  /** A point in time with millisecond precision, read back as an ISO-8601 string in UTC. */
  timestamp(name: string): TimestampColumn<string | Date> {
    return new TimestampColumn<string | Date>(this.#spec(name, { sqlite: 'datetime', pgsql: 'timestamptz(3)' }));
  }

  /**
   * `created_at` and `updated_at`, both set to the current time on insert — and a mark on the table: a repository's `insert()`,
   * `insertMany()`, `update()` and relation writes (a pivot's links too) stamp them from the app's clock, the column default covers other writes. See `docs/migrations.md#timestamps-and-soft-deletes`.
   */
  timestamps(): void {
    this.timestamp('created_at').useCurrent();
    this.timestamp('updated_at').useCurrent();
    this.#parts.markers.add('timestamps');
  }

  /**
   * `deleted_at` — and a mark on the table: a repository's `delete()` sets it, and its reads leave deleted rows out.
   * See `docs/migrations.md#timestamps-and-soft-deletes`.
   */
  softDeletes(): void {
    this.timestamp('deleted_at').nullable();
    this.#parts.markers.add('soft_deletes');
  }

  /**
   * Says that this table is a record of its own, though it has exactly two foreign keys to two other tables that are unique together
   * (a file per person and event): `db:types` gives it a `belongsTo` per key and no `belongsToMany` between the two tables. Without it
   * such a table is read as a pivot. See `docs/migrations.md#relations-from-foreign-keys`.
   */
  notPivot(): void {
    this.#open();
    this.#parts.notPivot = true;
  }

  /** A big integer that references another table: `table.foreignId('user_id').constrained().cascadeOnDelete()`. */
  foreignId(name: string): ForeignIdColumn<number> {
    return new ForeignIdColumn<number>(this.#spec(name, { sqlite: 'integer', pgsql: 'bigint' }));
  }

  /** A UUID that references another table: `table.foreignUuid('user_id').constrained().cascadeOnDelete()`. */
  foreignUuid(name: string): ForeignIdColumn<string> {
    return new ForeignIdColumn<string>(this.#spec(name, { sqlite: 'uuid' as DataTypeExpression, pgsql: 'uuid' as DataTypeExpression }));
  }

  index(columns: string | readonly string[], name?: string): void {
    this.#index(columns, false, name);
  }

  /** A unique index over one or more columns (for one column, `.unique()` on the column is shorter). */
  unique(columns: string | readonly string[], name?: string): void {
    this.#index(columns, true, name);
  }

  /** Changing a table only: drops a column. */
  dropColumn(name: string): void {
    this.#open();
    this.#parts.drops.push(name);
  }

  /** Changing a table only: drops an index by name (`{table}_{columns}_index`). */
  dropIndex(name: string): void {
    this.#open();
    this.#parts.dropIndexes.push(name);
  }

  /** Changing a table only: drops a unique index by name (`{table}_{columns}_unique`). SQLite drops no indexed column. */
  dropUnique(name: string): void {
    this.#open();
    this.#parts.dropIndexes.push(name);
  }

  /**
   * A named check constraint on the table: `table.check('events_dates_check', 'ends_at >= starts_at')`. `sql` is the condition, written
   * in SQL that both drivers accept; it is not looked into. Giving it to an existing table works on Postgres only (SQLite cannot add a
   * constraint to a table: use raw SQL). See `docs/migrations.md#check-constraints`.
   */
  check(name: string, sql: string): void {
    this.#open();
    if (!name || !sql.trim()) throw new Error(`check() on table "${this.table}" needs a name and a condition.`);
    this.#parts.checks.push({ name, sql });
  }

  /** Changing a table only, on Postgres only: drops a check constraint by name (`{table}_{column}_check` for `oneOf()`). */
  dropCheck(name: string): void {
    this.#open();
    this.#parts.dropChecks.push(name);
  }

  /** Changing a table only: renames a column. */
  renameColumn(from: string, to: string): void {
    this.#open();
    this.#parts.renames.push({ from, to });
  }

  /**
   * Changing a table only: makes an existing column NOT NULL — after a `schema.data()` step has filled it. A NULL left in it stops the
   * migration, which is rolled back. Postgres only: `migrate` refuses the plan on SQLite. See `docs/migrations.md#changing-the-data`.
   */
  notNull(column: string): void {
    this.#nullability(column, false);
  }

  /** Changing a table only: lets an existing column hold NULL. Postgres only, like `notNull()`. */
  nullable(column: string): void {
    this.#nullability(column, true);
  }

  /** Changing a table only: takes a column out of use one release before it is dropped; runs no statement. See `docs/migrations.md#retiring-a-column`. */
  retire(column: string): void {
    this.#open();
    this.#parts.retirements.push(column);
  }

  /**
   * @internal — closes the description once the callback that built it has returned: a column modifier or a new column after that (from an
   * `async` callback, or a later step) throws instead of changing a table the plan already holds.
   */
  seal(): void {
    this.#sealed = true;
    for (const spec of this.#parts.columns) closedSpecs.add(spec);
    for (const spec of this.#parts.columns) {
      if (spec.references) Object.freeze(spec.references);
      if (spec.default) Object.freeze(spec.default);
      Object.freeze(spec);
    }
    const { columns, indexes, drops, dropIndexes, renames, nullability, retirements, checks, dropChecks } = this.#parts;
    for (const list of [columns, indexes, drops, dropIndexes, renames, nullability, retirements, checks, dropChecks]) Object.freeze(list);
  }

  /** @internal — every index to create: table-level ones and `.unique()` on columns — all named, so all droppable. */
  allIndexes(): IndexSpec[] {
    const columnUniques = this.#parts.columns.filter((c) => c.unique).map((c) => ({ columns: [c.name], unique: true, name: `${this.table}_${c.name}_unique` }));
    return [...columnUniques, ...this.#parts.indexes];
  }

  #open(): void {
    if (this.#sealed) throw closedPlan();
  }

  #nullability(column: string, nullable: boolean): void {
    this.#open();
    if (this.#parts.nullability.some((change) => change.column === column)) throw new Error(`Column "${column}" of table "${this.table}" is made NOT NULL or nullable twice.`);
    this.#parts.nullability.push({ column, nullable });
  }

  #index(columns: string | readonly string[], unique: boolean, name?: string): void {
    this.#open();
    const list = typeof columns === 'string' ? [columns] : columns;
    this.#parts.indexes.push({ columns: list, unique, name: name ?? `${this.table}_${list.join('_')}_${unique ? 'unique' : 'index'}` });
  }

  #add<T>(name: string, type: Record<Driver, DataTypeExpression>): Column<T> {
    return new Column<T>(this.#spec(name, type));
  }

  #spec(name: string, type: Record<Driver, DataTypeExpression>, extra: Partial<ColumnSpec> = {}): ColumnSpec {
    this.#open();
    if (this.#parts.columns.some((column) => column.name === name)) throw new Error(`Column "${name}" is defined twice on table "${this.table}".`);
    const spec: ColumnSpec = { name, table: this.table, type, nullable: false, primary: false, identity: false, unique: false, secret: false, ...extra };
    this.#parts.columns.push(spec);
    return spec;
  }
}

/** Applies a column's modifiers to Kysely's column builder for `driver`. */
export function compileColumn(spec: ColumnSpec, driver: Driver): [DataTypeExpression, (column: ColumnDefinitionBuilder) => ColumnDefinitionBuilder] {
  return [
    spec.type[driver],
    (column) => {
      let c = column;
      if (spec.primary) c = c.primaryKey();
      if (spec.identity) c = driver === 'sqlite' ? c.autoIncrement() : c.generatedByDefaultAsIdentity();
      if (!spec.nullable && !spec.primary) c = c.notNull();
      if (spec.default) c = c.defaultTo(defaultOf(spec.default, driver));
      if (spec.oneOf) c = c.modifyEnd(oneOfCheck(spec));
      if (spec.references) {
        c = c.references(`${spec.references.table}.${spec.references.column}`);
        if (spec.references.onDelete) c = c.onDelete(spec.references.onDelete);
      }
      return c;
    },
  ];
}

/** The name of the constraint `oneOf()` makes. */
export const oneOfName = (table: string, column: string): string => `${table}_${column}_check`;

/** `constraint "t_c_check" check ("c" in ('a', 'b'))`; the values are written as literals with their quotes doubled. */
function oneOfCheck(spec: ColumnSpec): RawBuilder<unknown> {
  return sql`constraint ${sql.id(oneOfName(spec.table, spec.name))} check (${sql.id(spec.name)} in (${sql.join(spec.oneOf!.map((value) => sql.lit(value)))}))`;
}

function defaultOf(value: NonNullable<ColumnSpec['default']>, driver: Driver): unknown {
  if ('now' in value) return now(driver);
  if ('uuidv7' in value) return sql.raw(driver === 'sqlite' ? UUIDV7_SQLITE : UUIDV7_PGSQL);
  return literal(value.value);
}

export function now(driver: Driver): Expression<string> {
  // SQLite stores what the adapter reads back from Postgres: ISO-8601 in UTC, milliseconds.
  return driver === 'sqlite' ? sql<string>`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))` : sql<string>`now()`;
}

function literal(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (value !== null && typeof value === 'object') return JSON.stringify(value);
  return value;
}

export type { ColumnSpec, IndexSpec };
