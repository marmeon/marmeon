import { CompiledQuery, type DatabaseConnection, type RootOperationNode } from 'kysely';
import { deriveRelations, introspect, type Introspected, type Relation } from './introspection.ts';
import { assertNotMigrated, checkMigrationState, MigrationStateError } from './migration-state.ts';
import { emptyProjection, factsOf, type SchemaProjection } from './schema/projection.ts';
import type { Driver } from './schema/blueprint.ts';

/** How a column's values must be converted when they arrive inside nested JSON (relations). */
export type ColumnKind = 'boolean' | 'json' | 'timestamp' | 'uuid' | { decimal: number } | 'other';

/** What the metadata holds about the schema, as one value: swapped as a whole when it is loaded or published. */
interface Facts {
  readonly kinds: ReadonlyMap<string, ReadonlyMap<string, ColumnKind>>;
  readonly secrets: ReadonlyMap<string, ReadonlySet<string>>;
  readonly columns: ReadonlyMap<string, readonly string[]>;
  readonly relations: ReadonlyMap<string, ReadonlyMap<string, Relation>>;
  readonly problems: readonly string[];
  readonly softDeletes: ReadonlySet<string>;
  readonly timestamps: ReadonlySet<string>;
}

const NO_FACTS: Facts = { kinds: new Map(), secrets: new Map(), columns: new Map(), relations: new Map(), problems: [], softDeletes: new Set(), timestamps: new Set() };

/** The facts of a catalog reading or of a projection (in the form of one), derived by the same code. */
function factsFrom(found: Introspected): Facts {
  const kinds = new Map<string, Map<string, ColumnKind>>();
  for (const [table, types] of found.types) kinds.set(table, new Map([...types].map(([column, type]) => [column, kindOf(type)])));
  const secrets = new Map<string, Set<string>>();
  for (const { table, column } of found.secretColumns) {
    let columns = secrets.get(table);
    if (!columns) secrets.set(table, (columns = new Set()));
    columns.add(column);
  }
  const derived = deriveRelations(found);
  return {
    kinds,
    secrets,
    columns: new Map([...found.columns].map(([table, columns]) => [table, columns.filter((column) => !secrets.get(table)?.has(column))])),
    relations: derived.relations,
    problems: derived.problems,
    softDeletes: new Set(found.markers.filter((m) => m.marker === 'soft_deletes').map((m) => m.table)),
    timestamps: new Set(found.markers.filter((m) => m.marker === 'timestamps').map((m) => m.table)),
  };
}

const projected = new WeakMap<SchemaProjection, Map<Driver, Facts>>();

/** The facts of a projection for a driver — once per projection: the secret guard keeps what it derives from the maps. */
function factsOfProjection(projection: SchemaProjection, driver: Driver): Facts {
  let byDriver = projected.get(projection);
  if (!byDriver) projected.set(projection, (byDriver = new Map()));
  let facts = byDriver.get(driver);
  if (!facts) byDriver.set(driver, (facts = factsFrom(factsOf(projection, driver))));
  return facts;
}

/** Where a managed connection learns what it needs besides the database: the projection of the migration files, and who else asks. */
export interface SchemaSource {
  /** The projection of the app's migration files. Without one, the schema is empty until a migrator publishes its own. */
  projection?(): Promise<SchemaProjection>;
  /** A connection other than `default` takes the migration state of `default`: this resolves when it is fine and throws when it is not. */
  follow?(): Promise<void>;
  /** The database has migrations the code does not know (a process of an older release during a deploy). */
  ahead?(migrations: readonly string[]): void;
}

/** How soon a refused connection looks at the database again. */
const RECHECK_MS = 1000;

/**
 * What the connection knows about its schema: column kinds (for relations), secret columns, the relations the foreign keys
 * describe, and the tables the migrations marked with `timestamps()` and `softDeletes()`.
 *
 * On a `managed` connection it comes from the projection of the migrations (published by the migrator that ran in this process, or
 * computed from the migration files), and the one query the database is asked is which migrations ran: when it lacks one the
 * code has, every query is refused ({@link MigrationStateError}). On a connection another tool manages (`managed: false`) it is read
 * from the database's catalog, **on the connection being acquired** — never through the pool. A lookup through the `Kysely` instance
 * from inside a transaction would wait for the very connection the transaction holds: on SQLite (one connection) forever, on
 * Postgres it would quietly take a second one. There schema changes mark it stale; the next acquired connection loads it again.
 */
export class SchemaMetadata {
  readonly #driver: Driver;
  readonly #name: string;
  readonly #managed: boolean;
  readonly #source: SchemaSource | undefined;
  /** What every connection sees: the published projection, or the catalog as last read. */
  #published: Facts = NO_FACTS;
  /** What the code of `owner` — a migration's transaction — sees instead, see {@link as}. */
  readonly #during = new Map<object, Facts>();
  #current: Facts = NO_FACTS;
  #projection: SchemaProjection | undefined;
  /** Managed: the migrator of this process handed over the projection, so there is nothing to compare with the database. */
  #handedOver = false;
  /** Managed: the migrations were compared with the database and fit. */
  #ready = false;
  /** Managed: why the last comparison refused, and when — asked again after {@link RECHECK_MS}. */
  #refused: { error: unknown; at: number } | undefined;
  #loaded = false;
  #stale = true;
  #loading: Promise<void> | undefined;
  /** Connections whose open transaction changed the schema: what was loaded may be their own, uncommitted view. */
  readonly #changing = new Set<object>();
  /** The connection the loaded metadata was read on — its view, while it holds a schema change. */
  #loadedOn: object | undefined;
  /** Resolved once no connection holds a schema change. */
  #idle: { promise: Promise<void>; resolve: () => void } | undefined;

  /** `name` is the connection's, for the errors of its migrations; `managed: false` reads the catalog and asks for no migrations. */
  constructor(driver: Driver, name = 'default', managed = true, source?: SchemaSource) {
    this.#driver = driver;
    this.#name = name;
    this.#managed = managed;
    this.#source = source;
  }

  /** The database it describes: `sqlite` or `pgsql`. */
  get driver(): Driver {
    return this.#driver;
  }

  /** Whether the schema comes from the migrations; `false`: another tool manages the database and the catalog is read. */
  get managed(): boolean {
    return this.#managed;
  }

  /** Managed: the projection this metadata works with, once it has one (handed over, or loaded from the migration files). */
  get projection(): SchemaProjection | undefined {
    return this.#projection;
  }

  /** Managed: whether the migrations were compared with the database (or handed over), so queries are answered. */
  get ready(): boolean {
    return this.#handedOver || this.#ready;
  }

  /** Table → column → kind, as declared (SQLite) or reported (Postgres). */
  get kinds(): ReadonlyMap<string, ReadonlyMap<string, ColumnKind>> {
    return this.#current.kinds;
  }

  /** Table → its secret columns. */
  get secrets(): ReadonlyMap<string, ReadonlySet<string>> {
    return this.#current.secrets;
  }

  /** Table → its columns without the secret ones, in their order: what a relation loads unless told otherwise. */
  get columns(): ReadonlyMap<string, readonly string[]> {
    return this.#current.columns;
  }

  /** Table → relation name → relation, derived from the foreign keys (as `db:types` derives them). */
  get relations(): ReadonlyMap<string, ReadonlyMap<string, Relation>> {
    return this.#current.relations;
  }

  /** What could not be derived (two foreign keys to one table without `.inverse()`, …) — `db:types` stops on these. */
  get problems(): readonly string[] {
    return this.#current.problems;
  }

  /** Tables whose migration called `softDeletes()`. */
  get softDeletes(): ReadonlySet<string> {
    return this.#current.softDeletes;
  }

  /** Tables whose migration called `timestamps()`. */
  get timestamps(): ReadonlySet<string> {
    return this.#current.timestamps;
  }

  /**
   * Whether a query may be compiled with what is loaded, synchronously: loaded, not stale, not loading, and no open
   * transaction has changed the schema (or sees one of its own, see {@link during}). Otherwise the connection resolves its
   * placeholders once it runs it.
   */
  get fresh(): boolean {
    return this.#loaded && !this.#stale && this.#loading === undefined && this.#changing.size === 0 && this.#during.size === 0;
  }

  /**
   * Managed: the schema is this projection from now on, and the migrations need no comparison with the database — the migrator of
   * this process has just made it so. A refusal is lifted.
   */
  publish(projection: SchemaProjection): void {
    if (!this.#managed) return;
    this.#handedOver = true;
    this.#projection = projection;
    this.#ready = true;
    this.#refused = undefined;
    this.#published = this.#current = factsOfProjection(projection, this.#driver);
    this.#loaded = true;
    this.#stale = false;
  }

  /**
   * Managed: until {@link after}, the code running on `owner` — the connection of a migration's transaction — sees `projection`
   * (the schema as that migration has changed it so far); every other connection keeps the published one.
   */
  during(owner: object, projection: SchemaProjection): void {
    if (this.#managed) this.#during.set(owner, factsOfProjection(projection, this.#driver));
  }

  /** The migration on `owner` no longer sees a schema of its own. */
  after(owner: object): void {
    this.#during.delete(owner);
  }

  /**
   * Runs `work` — which resolves a query or reads a result, synchronously — with the schema `owner` sees: its own while a migration
   * on it has one ({@link during}), the published one otherwise.
   */
  as<T>(owner: object, work: () => T): T {
    const own = this.#during.get(owner);
    if (own === undefined) return work();
    const before = this.#current;
    this.#current = own;
    try {
      return work();
    } finally {
      this.#current = before;
    }
  }

  invalidate(): void {
    if (this.#managed) return;
    this.#stale = true;
  }

  /**
   * Forgets what was handed over, compared or read: the next query starts as the first query of a process does — the migration files
   * are read again and compared with the database, or the catalog is.
   */
  reload(): void {
    this.#handedOver = false;
    this.#ready = false;
    this.#refused = undefined;
    this.#stale = true;
  }

  /** A transaction on `connection` changed the schema: not fresh until it ends ({@link release}). */
  hold(connection: object): void {
    if (this.#managed) return;
    this.#changing.add(connection);
    this.#stale = true;
    if (!this.#idle) {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => (resolve = r));
      this.#idle = { promise, resolve };
    }
  }

  /** Whether an open transaction on `connection` changed the schema — what it rolls back may undo that change. */
  holds(connection: object): boolean {
    return this.#changing.has(connection);
  }

  /** The transaction on `connection` ended — committed or rolled back: load again. */
  release(connection: object): void {
    if (!this.#changing.delete(connection)) return;
    this.#stale = true;
    if (this.#changing.size === 0) {
      this.#idle?.resolve();
      this.#idle = undefined;
    }
  }

  /**
   * Loads what is stale, on `connection` — called by the driver whenever it hands out a connection. `owner` is the connection as
   * the driver knows it (`connection` may be a view of it).
   */
  async refresh(connection: DatabaseConnection, owner: object = connection): Promise<void> {
    // A load already under way may predate the latest change: wait for it, then look again.
    while (this.#loading || this.#stale) {
      this.#loading ??= this.#load(connection, owner).finally(() => (this.#loading = undefined));
      await this.#loading;
    }
  }

  /**
   * Makes what is loaded safe to resolve a query of `owner` with. Managed, that is `refresh` — what is published is the schema of
   * the committed database, and a migration's own view is kept apart ({@link during}); nobody waits. On a connection another tool
   * manages, while a transaction on another connection has changed the schema, nothing loaded is safe: neither that transaction's
   * uncommitted view nor the committed one it is about to replace — so this waits until it ends, at most `limit` ms, then throws.
   * The connection holding the change resolves with its own view.
   */
  async settle(connection: DatabaseConnection, owner: object, { limit, name }: { limit: number; name: string }): Promise<void> {
    if (this.#managed) return this.refresh(connection, owner);
    const deadline = Date.now() + limit;
    for (;;) {
      if (this.#idle && !this.#changing.has(owner)) {
        await this.#ended(this.#idle.promise, deadline, limit, name);
        continue;
      }
      await this.refresh(connection, owner);
      if (this.#idle && !this.#changing.has(owner)) continue;
      if (this.#changing.has(owner) && this.#loadedOn !== owner) {
        this.#stale = true; // loaded on another connection: not this transaction's view
        continue;
      }
      return;
    }
  }

  async #ended(idle: Promise<void>, deadline: number, limit: number, name: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<'late'>((resolve) => (timer = setTimeout(() => resolve('late'), Math.max(0, deadline - Date.now()))));
    try {
      if ((await Promise.race([idle, late])) === 'late') {
        throw new Error(
          `A query on the database connection "${name}" waited ${limit / 1000} s for a transaction that changes the schema to end ` +
            '(a migration in this process, on another connection), and it did not. The query reads rows or depends on what the ' +
            'migrations marked (secret columns, soft deletes, timestamps), which that transaction is changing, so it was not sent. ' +
            'See docs/migrations.md#migrating-a-running-app.',
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async #load(connection: DatabaseConnection, owner: object): Promise<void> {
    // Stale from here on only if a schema change happens while loading.
    this.#stale = false;
    try {
      if (this.#managed) await this.#loadMigrated(connection);
      else await this.#loadCatalog(connection, owner);
    } catch (error) {
      this.#stale = true;
      throw error;
    }
  }

  /** Throws when the catalog cannot be read: nothing is loaded then, and every query of the connection fails (stale stays set). */
  async #loadCatalog(connection: DatabaseConnection, owner: object): Promise<void> {
    const run = async <R>(sql: string) => (await connection.executeQuery<R>(CompiledQuery.raw(sql))).rows;
    const found = await introspect(run, this.#driver);
    // Not a database Marmeon migrates: with its record of migrations the catalog alone would hide what the migrations say.
    assertNotMigrated(found.columns, this.#name);
    this.#published = this.#current = factsFrom(found);
    this.#loadedOn = owner;
    this.#loaded = true;
  }

  /** The schema of the migration files, once the database is known to have the migrations they stand for. */
  async #loadMigrated(connection: DatabaseConnection): Promise<void> {
    if (this.#refused && Date.now() - this.#refused.at < RECHECK_MS) throw this.#refused.error;
    if (this.#handedOver) return;
    const projection = await (this.#source?.projection?.() ?? Promise.resolve(emptyProjection));
    // The migrator of this process may have handed over its own while the files were read.
    if (this.#handedOver) return;
    if (!this.#ready) {
      try {
        // A connection that follows `default` is as ready as it is; its own database holds no record of migrations.
        if (this.#source?.follow) await this.#source.follow();
        else {
          const run = async <R>(sql: string) => (await connection.executeQuery<R>(CompiledQuery.raw(sql))).rows;
          const { unknown } = await checkMigrationState(run, this.#driver, this.#name, projection.migrations.map((m) => m.name));
          if (unknown.length > 0) this.#source?.ahead?.(unknown);
        }
      } catch (error) {
        // The migrator of this process handed over meanwhile: the refusal is out of date.
        if (this.#handedOver) return;
        if (error instanceof MigrationStateError) this.#refused = { error, at: Date.now() };
        throw error;
      }
      if (this.#handedOver) return;
      this.#ready = true;
    }
    this.#projection = projection;
    this.#published = this.#current = factsOfProjection(projection, this.#driver);
    this.#loaded = true;
  }
}

export function kindOf(type: string): ColumnKind {
  const decimal = /^(?:numeric|decimal)\(\s*\d+\s*,\s*(\d+)\s*\)$/.exec(type);
  if (decimal) return { decimal: Number(decimal[1]) };
  if (type === 'boolean' || type === 'bool') return 'boolean';
  if (type === 'json' || type === 'jsonb') return 'json';
  if (type === 'datetime' || type.startsWith('timestamp')) return 'timestamp';
  if (type === 'uuid') return 'uuid';
  return 'other';
}

const DDL = new Set(['CreateTableNode', 'AlterTableNode', 'DropTableNode', 'CreateIndexNode', 'DropIndexNode']);

/** Whether a statement changes what a catalog reading holds: DDL (indexes too: a unique one makes a hasOne). */
export function changesSchema(node: RootOperationNode): boolean {
  return DDL.has(node.kind);
}

const STATEMENT_DDL = /(?:create|alter|drop)\b/iy;
const STATEMENT_DDL_OR_DO = /(?:create|alter|drop|do)\b/iy;
const DOLLAR_TAG = /\$(?:[A-Za-z_]\w*)?\$/y;

/**
 * Whether raw SQL (`sql\`alter table …\``) contains a statement that begins with `create`, `alter` or `drop`.
 * Only a statement's start counts, after literals and comments are dropped: a query that merely mentions one of the words
 * (a literal, a CTE named `created`) must not reload the metadata, because the reload would make it measurably slower than
 * the same query without the word. A missed change leaves the metadata as loaded until the next recognized one; a stray match
 * only reloads. An unterminated literal, quoted identifier, comment or dollar tag runs to the end of the text; nested comments
 * and `E''` escapes are not parsed. With `withDo`, a statement that begins with `do` (a block of Postgres code) counts too.
 */
export function isRawSchemaChange(sql: string, withDo = false): boolean {
  const statement = withDo ? STATEMENT_DDL_OR_DO : STATEMENT_DDL;
  const end = sql.length;
  let i = 0;
  let atStart = true;
  while (i < end) {
    const char = sql[i]!;
    if (char === "'" || char === '"') {
      i = endOfQuoted(sql, i, char);
      atStart = false;
    } else if (char === '-' && sql[i + 1] === '-') {
      const newline = sql.indexOf('\n', i);
      i = newline < 0 ? end : newline + 1;
    } else if (char === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2);
      i = close < 0 ? end : close + 2;
    } else if (char === '$' && !/[\w$]/.test(sql[i - 1] ?? '') && (DOLLAR_TAG.lastIndex = i) >= 0 && DOLLAR_TAG.exec(sql)) {
      const tag = sql.slice(i, DOLLAR_TAG.lastIndex);
      const close = sql.indexOf(tag, i + tag.length);
      i = close < 0 ? end : close + tag.length;
      atStart = false;
    } else if (char === ';') {
      atStart = true;
      i++;
    } else if (/\s/.test(char)) {
      i++;
    } else {
      if (atStart) {
        statement.lastIndex = i;
        if (statement.test(sql)) return true;
      }
      atStart = false;
      i++;
    }
  }
  return false;
}

/** Index after the quoted literal or identifier that opens at `start` (a doubled quote stays inside it). Linear, without recursion. */
function endOfQuoted(sql: string, start: number, quote: string): number {
  let from = start + 1;
  for (;;) {
    const close = sql.indexOf(quote, from);
    if (close < 0) return sql.length;
    if (sql[close + 1] !== quote) return close + 1;
    from = close + 2;
  }
}
