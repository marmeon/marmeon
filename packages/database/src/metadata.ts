import { CompiledQuery, TableNode, type DatabaseConnection, type RootOperationNode } from 'kysely';
import { deriveRelations, introspect, type Relation } from './introspection.ts';
import { fold } from './secret-guard.ts';
import type { Driver } from './schema/blueprint.ts';

/** Internal bookkeeping: the columns migrations marked `.secret()` (written by the migrator). */
export const SECRETS_TABLE = 'secret_columns';
/**
 * Internal bookkeeping: what migrations declared beyond the columns (written by the migrator) — `timestamps()` and
 * `softDeletes()` per table, `.inverse()` per foreign key. See `docs/migrations.md#timestamps-and-soft-deletes`.
 */
export const MARKERS_TABLE = 'schema_markers';

/** How a column's values must be converted when they arrive inside nested JSON (relations). */
export type ColumnKind = 'boolean' | 'json' | 'timestamp' | { decimal: number } | 'other';

/**
 * What the connection knows about its schema: column kinds (for relations), secret columns, the relations the foreign keys
 * describe, and the tables the migrations marked with `timestamps()` and `softDeletes()`.
 *
 * Loaded **on the connection being acquired** — never through the pool. A lookup through the
 * `Kysely` instance from inside a transaction would wait for the very connection the transaction
 * holds: on SQLite (one connection) forever, on Postgres it would quietly take a second one.
 * Schema changes mark it stale; the next acquired connection loads it again.
 */
export class SchemaMetadata {
  readonly #driver: Driver;
  #kinds = new Map<string, Map<string, ColumnKind>>();
  #secrets = new Map<string, ReadonlySet<string>>();
  #columns = new Map<string, readonly string[]>();
  #relations: ReadonlyMap<string, ReadonlyMap<string, Relation>> = new Map();
  #problems: readonly string[] = [];
  #softDeletes = new Set<string>();
  #timestamps = new Set<string>();
  #loaded = false;
  #stale = true;
  #loading: Promise<void> | undefined;
  /** Connections whose open transaction changed the schema: what was loaded may be their own, uncommitted view. */
  readonly #changing = new Set<object>();
  /** The connection the loaded metadata was read on — its view, while it holds a schema change. */
  #loadedOn: object | undefined;
  /** Resolved once no connection holds a schema change. */
  #idle: { promise: Promise<void>; resolve: () => void } | undefined;

  constructor(driver: Driver) {
    this.#driver = driver;
  }

  /** The database it describes: `sqlite` or `pgsql`. */
  get driver(): Driver {
    return this.#driver;
  }

  /** Table → column → kind, as declared (SQLite) or reported (Postgres). */
  get kinds(): ReadonlyMap<string, ReadonlyMap<string, ColumnKind>> {
    return this.#kinds;
  }

  /** Table → its secret columns. */
  get secrets(): ReadonlyMap<string, ReadonlySet<string>> {
    return this.#secrets;
  }

  /** Table → its columns without the secret ones, in their order: what a relation loads unless told otherwise. */
  get columns(): ReadonlyMap<string, readonly string[]> {
    return this.#columns;
  }

  /** Table → relation name → relation, derived from the foreign keys (as `db:types` derives them). */
  get relations(): ReadonlyMap<string, ReadonlyMap<string, Relation>> {
    return this.#relations;
  }

  /** What could not be derived (two foreign keys to one table without `.inverse()`, …) — `db:types` stops on these. */
  get problems(): readonly string[] {
    return this.#problems;
  }

  /** Tables whose migration called `softDeletes()`. */
  get softDeletes(): ReadonlySet<string> {
    return this.#softDeletes;
  }

  /** Tables whose migration called `timestamps()`. */
  get timestamps(): ReadonlySet<string> {
    return this.#timestamps;
  }

  /**
   * Whether a query may be compiled with what is loaded, synchronously: loaded, not stale, not loading, and no open
   * transaction has changed the schema. Otherwise the connection resolves its placeholders once it runs it.
   */
  get fresh(): boolean {
    return this.#loaded && !this.#stale && this.#loading === undefined && this.#changing.size === 0;
  }

  invalidate(): void {
    this.#stale = true;
  }

  /** A transaction on `connection` changed the schema: not fresh until it ends ({@link release}). */
  hold(connection: object): void {
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
   * Makes what is loaded safe to resolve a query of `owner` with. While a transaction on another connection has changed the
   * schema, nothing loaded is: neither that transaction's uncommitted view nor the committed one it is about to replace — so
   * this waits until it ends, at most `limit` ms, then throws. The connection holding the change resolves with its own view.
   */
  async settle(connection: DatabaseConnection, owner: object, { limit, name }: { limit: number; name: string }): Promise<void> {
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
      const run = async <R>(sql: string) => (await connection.executeQuery<R>(CompiledQuery.raw(sql))).rows;
      const facts = await introspect(run, this.#driver);
      const kinds = new Map<string, Map<string, ColumnKind>>();
      for (const [table, types] of facts.types) kinds.set(table, new Map([...types].map(([column, type]) => [column, kindOf(type)])));

      // The bookkeeping table exists once a migration ran. Checked first: on Postgres a failing query would abort the
      // transaction it runs in (tests run inside one).
      const secrets = new Map<string, Set<string>>();
      if (kinds.has(SECRETS_TABLE)) {
        for (const { table_name, column_name } of await run<{ table_name: string; column_name: string }>(`select table_name, column_name from ${SECRETS_TABLE}`)) {
          let table = secrets.get(table_name);
          if (!table) secrets.set(table_name, (table = new Set()));
          table.add(column_name);
        }
      }
      const derived = deriveRelations(facts);
      this.#kinds = kinds;
      this.#secrets = secrets;
      this.#columns = new Map([...facts.columns].map(([table, columns]) => [table, columns.filter((column) => !secrets.get(table)?.has(column))]));
      this.#relations = derived.relations;
      this.#problems = derived.problems;
      this.#softDeletes = new Set(facts.markers.filter((m) => m.marker === 'soft_deletes').map((m) => m.table));
      this.#timestamps = new Set(facts.markers.filter((m) => m.marker === 'timestamps').map((m) => m.table));
      this.#loadedOn = owner;
      this.#loaded = true;
    } catch (error) {
      this.#stale = true;
      throw error;
    }
  }
}

function kindOf(type: string): ColumnKind {
  const decimal = /^(?:numeric|decimal)\(\s*\d+\s*,\s*(\d+)\s*\)$/.exec(type);
  if (decimal) return { decimal: Number(decimal[1]) };
  if (type === 'boolean' || type === 'bool') return 'boolean';
  if (type === 'json' || type === 'jsonb') return 'json';
  if (type === 'datetime' || type.startsWith('timestamp')) return 'timestamp';
  return 'other';
}

const DDL = new Set(['CreateTableNode', 'AlterTableNode', 'DropTableNode', 'CreateIndexNode', 'DropIndexNode']);
const BOOKKEEPING = new Set([SECRETS_TABLE, MARKERS_TABLE]);

/** Whether a statement changes what the metadata holds: DDL (indexes too: a unique one makes a hasOne), or the migrator's books. */
export function changesSchema(node: RootOperationNode): boolean {
  // Raw DDL (`sql\`alter table …\``) is not recognized: the next blueprint change reloads.
  if (DDL.has(node.kind)) return true;
  if (node.kind !== 'InsertQueryNode' && node.kind !== 'UpdateQueryNode' && node.kind !== 'DeleteQueryNode') return false;
  const target = node.kind === 'InsertQueryNode' ? node.into : node.kind === 'UpdateQueryNode' ? node.table : node.from.froms[0];
  // In any case: SQLite writes to `SECRET_COLUMNS` as to `secret_columns`.
  return target !== undefined && TableNode.is(target) && BOOKKEEPING.has(fold(target.table.identifier.name));
}
