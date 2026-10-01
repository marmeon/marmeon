import { sql, type ColumnDefinitionBuilder, type CreateTableBuilder, type Expression } from 'kysely';

/** What Kysely accepts as a column type (the type itself is not exported). */
type DataTypeExpression = Parameters<CreateTableBuilder<string, never>['addColumn']>[1];

export type Driver = 'sqlite' | 'pgsql';

type OnDelete = 'cascade' | 'set null' | 'restrict' | 'no action';

/** What a column is, independent of the dialect — compiled by {@link Blueprint} for the connection's driver. */
interface ColumnSpec {
  readonly name: string;
  readonly type: Record<Driver, DataTypeExpression>;
  nullable: boolean;
  primary: boolean;
  identity: boolean;
  unique: boolean;
  secret: boolean;
  default?: { value: unknown } | { now: true };
  references?: { table: string; column: string; onDelete?: OnDelete };
}

/**
 * One column, fluently: `table.string('email').unique()`. Columns are NOT NULL unless marked
 * `nullable()` (Laravel's default, not SQL's). `T` is the column's value type, so a default is
 * checked against it.
 */
export class Column<T> {
  protected readonly spec: ColumnSpec;

  constructor(spec: ColumnSpec) {
    this.spec = spec;
  }

  nullable(): Column<T | null> {
    this.spec.nullable = true;
    return this as Column<T | null>;
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

/** A foreign key column (`foreignId`); `constrained()` adds the reference. */
export class ForeignIdColumn<T> extends Column<T> {
  /** References `table.column` — by default the table named after the column (`user_id` → `users`) and its `id`. */
  constrained(table = `${this.spec.name.replace(/_id$/, '')}s`, column = 'id'): ConstrainedColumn<T> {
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
  #onDelete(action: OnDelete): this {
    this.spec.references!.onDelete = action;
    return this;
  }
}

type IndexSpec = { readonly columns: readonly string[]; readonly unique: boolean; readonly name: string };

/**
 * Describes a table the way Laravel's Blueprint does, and compiles it for SQLite or Postgres.
 * The declared types are chosen so the type generator (and the SQLite adapter) recognize them:
 * `boolean`, `json`, `datetime`/`timestamptz` stay recognizable on both drivers.
 */
export class Blueprint {
  readonly table: string;
  /** Columns to add (create, or alter). */
  readonly columns: ColumnSpec[] = [];
  readonly indexes: IndexSpec[] = [];
  readonly drops: string[] = [];
  readonly dropIndexes: string[] = [];
  readonly renames: { from: string; to: string }[] = [];

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

  uuid(name: string): Column<string> {
    return this.#add(name, { sqlite: 'uuid' as DataTypeExpression, pgsql: 'uuid' as DataTypeExpression });
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

  /** `created_at` and `updated_at`, both set to the current time on insert. */
  timestamps(): void {
    this.timestamp('created_at').useCurrent();
    this.timestamp('updated_at').useCurrent();
  }

  /** `deleted_at`, for soft deletes. */
  softDeletes(): void {
    this.timestamp('deleted_at').nullable();
  }

  /** A big integer that references another table: `table.foreignId('user_id').constrained().cascadeOnDelete()`. */
  foreignId(name: string): ForeignIdColumn<number> {
    return new ForeignIdColumn<number>(this.#spec(name, { sqlite: 'integer', pgsql: 'bigint' }));
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
    this.drops.push(name);
  }

  /** Changing a table only: drops an index by name (`{table}_{columns}_index`). */
  dropIndex(name: string): void {
    this.dropIndexes.push(name);
  }

  /** Changing a table only: drops a unique index by name (`{table}_{columns}_unique`). SQLite drops no indexed column. */
  dropUnique(name: string): void {
    this.dropIndexes.push(name);
  }

  /** Changing a table only: renames a column. */
  renameColumn(from: string, to: string): void {
    this.renames.push({ from, to });
  }

  /** Every index to create: table-level ones and `.unique()` on columns — all named, so all droppable. */
  allIndexes(): IndexSpec[] {
    const columnUniques = this.columns.filter((c) => c.unique).map((c) => ({ columns: [c.name], unique: true, name: `${this.table}_${c.name}_unique` }));
    return [...columnUniques, ...this.indexes];
  }

  #index(columns: string | readonly string[], unique: boolean, name?: string): void {
    const list = typeof columns === 'string' ? [columns] : columns;
    this.indexes.push({ columns: list, unique, name: name ?? `${this.table}_${list.join('_')}_${unique ? 'unique' : 'index'}` });
  }

  #add<T>(name: string, type: Record<Driver, DataTypeExpression>): Column<T> {
    return new Column<T>(this.#spec(name, type));
  }

  #spec(name: string, type: Record<Driver, DataTypeExpression>, extra: Partial<ColumnSpec> = {}): ColumnSpec {
    if (this.columns.some((column) => column.name === name)) throw new Error(`Column "${name}" is defined twice on table "${this.table}".`);
    const spec: ColumnSpec = { name, type, nullable: false, primary: false, identity: false, unique: false, secret: false, ...extra };
    this.columns.push(spec);
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
      if (spec.default) c = c.defaultTo('now' in spec.default ? now(driver) : literal(spec.default.value));
      if (spec.references) {
        c = c.references(`${spec.references.table}.${spec.references.column}`);
        if (spec.references.onDelete) c = c.onDelete(spec.references.onDelete);
      }
      return c;
    },
  ];
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
