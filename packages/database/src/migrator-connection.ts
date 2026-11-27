import { withCode } from '@marmeon/core/internal';
import { createQueryId, type DeleteQueryNode, type InsertQueryNode, type MergeQueryNode, type UpdateQueryNode, PostgresQueryCompiler, type QueryCompiler, OperationNodeTransformer, RawNode, type Kysely, type KyselyPlugin, type OperationNode, type PluginTransformQueryArgs, type PluginTransformResultArgs, type QueryId, type QueryResult, type RootOperationNode, TableNode, type UnknownRow } from 'kysely';
import type { Connections } from './connections.ts';
import { MarmeonMysqlCompiler } from './mysql-compiler.ts';
import { RowLockFreeCompiler } from './sqlite.ts';
import { hasExecutableComment, mysqlCommits, mysqlWords } from './schema/mysql-words.ts';
import { sqlChangesSchema, sqlWords } from './schema/sql-words.ts';
import type { Driver } from './schema/blueprint.ts';
import { unknownDriver } from './supported-driver.ts';
import { isMigratorTable } from './migration-state.ts';
import { SchemaError } from './schema/schema-error.ts';

// How the migrator and `db:show` reach a database the app's connection refuses (migrations pending, a record of migrations of a newer
// Marmeon, tables and no record). Not API: only they import it, and it is not exported from the package.

const MIGRATOR = new WeakMap<object, Map<string, Kysely<any>>>();

/** Called by {@link Connections} for each connection it opens. */
export function registerMigrator(connections: object, name: string, db: Kysely<any>): void {
  let byName = MIGRATOR.get(connections);
  if (!byName) MIGRATOR.set(connections, (byName = new Map()));
  byName.set(name, db);
}

const AS_IS = new WeakMap<object, Map<string, Kysely<any>>>();

/** Called by {@link Connections} for each connection it opens, with a Kysely that asks nothing of the migrations: no plugins, no schema metadata. */
export function registerInspection(connections: object, name: string, db: Kysely<any>): void {
  let byName = AS_IS.get(connections);
  if (!byName) AS_IS.set(connections, (byName = new Map()));
  byName.set(name, db);
}

/**
 * The connection for looking at a database as it is, whether or not its migrations ran (`db:show`). It resolves nothing, checks no
 * secret column and refuses nothing: never for a query of the app, and for commands that read no row's content.
 */
export function inspectionConnection(connections: Connections, name = 'default'): Kysely<any> {
  connections.get(name); // opens the connection's entry
  return AS_IS.get(connections)!.get(name)!;
}

/**
 * The connection the migrator keeps the record of migrations and the lock with. Unlike `connections.get()` it works on a database the
 * app's connection refuses (that refusal is what `migrate` and `migrate:fresh` are there to end), and it refuses every table that is not
 * the migrator's — it resolves no placeholders and plans no relations.
 */
export function migratorConnection(connections: Connections, name = 'default'): Kysely<any> {
  connections.get(name); // opens the connection's entry
  return MIGRATOR.get(connections)!.get(name)!;
}

/** Schemas that `Kysely` itself reads for the catalog: allowed on the migrator's connection. */
const CATALOG = new Set(['pg_catalog', 'information_schema']);
const CATALOG_TABLES = new Set(['sqlite_master', 'sqlite_schema']);
const DATA = new Set(['SelectQueryNode', 'InsertQueryNode', 'UpdateQueryNode', 'DeleteQueryNode', 'MergeQueryNode']);

/** The last segment of a table's name: `public.migrations` and `migrations` are one table. */
export function lastSegment(name: string): string {
  return (name.split('.').pop() ?? name).replaceAll('"', '').replaceAll('`', '');
}

class Visit extends OperationNodeTransformer {
  readonly #check: (table: TableNode) => void;

  constructor(check: (table: TableNode) => void) {
    super();
    this.#check = check;
  }

  protected override transformTable(node: TableNode): TableNode {
    this.#check(node);
    return super.transformTable(node);
  }
}

class Plugin implements KyselyPlugin {
  readonly #kinds: ReadonlySet<string>;
  readonly #check: (table: TableNode) => void;

  constructor(kinds: ReadonlySet<string>, check: (table: TableNode) => void) {
    this.#kinds = kinds;
    this.#check = check;
  }

  transformQuery({ node }: PluginTransformQueryArgs): RootOperationNode {
    if (this.#kinds.has(node.kind)) new Visit(this.#check).transformNode(node);
    return node;
  }

  transformResult({ result }: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    return Promise.resolve(result);
  }
}

/**
 * Finds the tables a write names, wherever the write stands in the query (a root, a CTE, a subquery, `insert … select`), and whether the
 * query holds raw SQL anywhere. The tables of a read outside any write are not checked.
 */
class WriteVisit extends OperationNodeTransformer {
  readonly #check: (table: TableNode) => void;
  #depth = 0;
  sawRaw = false;

  constructor(check: (table: TableNode) => void) {
    super();
    this.#check = check;
  }

  #within<T>(work: () => T): T {
    this.#depth++;
    try {
      return work();
    } finally {
      this.#depth--;
    }
  }

  protected override transformInsertQuery(node: InsertQueryNode, queryId?: QueryId): InsertQueryNode {
    return this.#within(() => super.transformInsertQuery(node, queryId));
  }

  protected override transformUpdateQuery(node: UpdateQueryNode, queryId?: QueryId): UpdateQueryNode {
    return this.#within(() => super.transformUpdateQuery(node, queryId));
  }

  protected override transformDeleteQuery(node: DeleteQueryNode, queryId?: QueryId): DeleteQueryNode {
    return this.#within(() => super.transformDeleteQuery(node, queryId));
  }

  protected override transformMergeQuery(node: MergeQueryNode, queryId?: QueryId): MergeQueryNode {
    return this.#within(() => super.transformMergeQuery(node, queryId));
  }

  protected override transformRaw(node: RawNode, queryId?: QueryId): RawNode {
    this.sawRaw = true;
    return super.transformRaw(node, queryId);
  }

  protected override transformTable(node: TableNode): TableNode {
    if (this.#depth > 0) this.#check(node);
    return super.transformTable(node);
  }
}

/**
 * On the migrator's connection: a statement on any table but the migrator's (or the catalog) throws before it is sent. Raw SQL is not looked into.
 * `migration_interruption` is the migrator's on MySQL only; on SQLite and Postgres it is the app's table and refused here like any other.
 */
export function onlyMigratorTables(driver: Driver): KyselyPlugin {
  return new Plugin(DATA, (table) => {
    const name = lastSegment(table.table.identifier.name);
    const schema = table.table.schema?.name;
    if (isMigratorTable(name, driver) || CATALOG_TABLES.has(name) || (schema !== undefined && CATALOG.has(schema))) return;
    throw new Error(`The migrator's connection reads and writes the migrator's tables only; "${name}" is not one of them.`);
  });
}

/**
 * On the `db` of a `schema.data()` step: a write to the migrator's tables throws before it is sent. Raw SQL is read by its words, as
 * `schema.raw()` reads it: a statement that names one of the tables (also by `sql.id()`, `sql.table()` or an alias) is refused, a read too.
 * A guard against mistakes, not a sandbox: a connection without its plugins or a query compiled by hand is not looked into.
 */
export function noMigratorWrites(driver: Driver): KyselyPlugin {
  const refuse = (name: string): never => {
    throw new SchemaError(
      withCode('D4', `Cannot write to "${name}": the table belongs to the migrator, and changing it by hand would make it lose track of which migrations ran. See docs/migrations.md#how-the-migrator-keeps-track.`),
    );
  };
  const refuseRaw = (name: string): never => {
    throw new SchemaError(
      withCode(
        'D4',
        `Cannot read or write "${name}" in raw SQL of a schema.data() step: the table belongs to the migrator, and changing it by hand would make it lose track of which migrations ran. ` +
          `Raw SQL is read by its words, and every word outside a string counts${driver === 'sqlite' ? ', and on SQLite the words of a string too, because SQLite reads a string as a name where a name is expected' : ''}; use the query builder to read it. ` +
          'See docs/migrations.md#how-the-migrator-keeps-track.',
      ),
    );
  };
  return {
    transformQuery({ node }: PluginTransformQueryArgs): RootOperationNode {
      const visit = new WriteVisit((table) => {
        const name = lastSegment(table.table.identifier.name);
        if (isMigratorTable(name, driver)) refuse(name);
      });
      visit.transformNode(node);
      // Raw SQL anywhere in the query: the whole text that is sent is read by its words (a read of the tables counts too, fail closed).
      if (visit.sawRaw) {
        const named = statementWords(compilerOf(driver).compileQuery(node, createQueryId()).sql, driver).find((word) => isMigratorTable(word, driver));
        if (named !== undefined) refuseRaw(named);
      }
      return node;
    },
    transformResult: ({ result }: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> => Promise.resolve(result),
  };
}

/** Nodes that hold bound or immediate values, which are data and never read as SQL. */
const VALUES = new Set(['ValueNode', 'PrimitiveValueListNode']);

/** The nodes of statements that create, change or drop schema objects. */
const SCHEMA_CHANGES = new Set([
  'CreateTableNode', 'AlterTableNode', 'DropTableNode', 'CreateIndexNode', 'DropIndexNode', 'CreateViewNode', 'DropViewNode',
  'CreateSchemaNode', 'DropSchemaNode', 'CreateTypeNode', 'DropTypeNode', 'AlterTypeNode', 'RefreshMaterializedViewNode',
]);

/**
 * The text of a raw node as it is sent: compiled by the compiler of the connection's dialect, so a name stands quoted and escaped, a
 * literal as that server reads it, a bound value as its placeholder (`?`, `$1`), and nothing is rebuilt here that could differ from what goes out.
 * The guards read this text, with the scanner of the driver.
 */
export function rawText(node: RawNode, driver: Driver): string {
  return compilerOf(driver).compileQuery(node, createQueryId()).sql;
}

const COMPILERS = new Map<Driver, QueryCompiler>();

/** The compiler the connection's dialect sends with. */
function compilerOf(driver: Driver): QueryCompiler {
  let compiler = COMPILERS.get(driver);
  if (compiler === undefined) {
    switch (driver) {
      case 'sqlite':
        compiler = new RowLockFreeCompiler();
        break;
      case 'pgsql':
        // What `PostgresDialect` makes: Marmeon gives Postgres no compiler of its own.
        compiler = new PostgresQueryCompiler();
        break;
      case 'mysql':
        compiler = new MarmeonMysqlCompiler();
        break;
      default:
        return unknownDriver(driver);
    }
    COMPILERS.set(driver, compiler);
  }
  return compiler;
}

/** The words of a statement text that the guards of the migrator's tables read: by the lexing of the driver. */
export function statementWords(text: string, driver: Driver): string[] {
  return driver === 'mysql' ? mysqlWords(text) : sqlWords(text, driver === 'pgsql' ? 'pgsql' : 'sqlite');
}

/** Whether a node holds, at any depth, a node that creates, changes or drops a schema object (`sql\`${db.schema.dropTable('t')}\``): such a statement is no text to read. */
export function nestsSchemaChange(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(nestsSchemaChange);
  if (typeof node !== 'object' || node === null) return false;
  const kind = (node as OperationNode).kind;
  // A bound value is data: a JSON value that looks like a node is no node.
  if (VALUES.has(kind)) return false;
  return SCHEMA_CHANGES.has(kind) || Object.values(node).some(nestsSchemaChange);
}

/**
 * On the `db` of a `schema.data()` step: DDL, in the query builder or as raw SQL that begins with `create`, `alter`, `drop` or `do`, throws before it is sent. On MySQL the raw SQL is read by
 * MySQL's rules, and every statement that ends the transaction of the step (`mysqlCommits`) throws as well. It is a guard
 * against mistakes, not a sandbox: a plugin-free connection or a compiled query is not looked into. A data step runs after
 * the plan was made; a schema change there would be missing from what the migration declares.
 */
export function noSchemaChanges(driver: Driver): KyselyPlugin {
  const refuse = (text?: string): never => {
    // On MySQL the text is of a statement that ends the transaction of the step (DDL, `commit`, `rollback`, `lock tables` …), not only of a schema change.
    const reason =
      text === undefined
        ? 'Cannot change the schema in a schema.data() step: the plan of a migration is made before it runs, and a change made here would not be part of it. '
        : 'Cannot run this statement in a schema.data() step: it ends or steers the transaction of the step, which the migrator controls, and a schema change would be missing from the plan of the migration. ' +
          (hasExecutableComment(text) ? 'A statement with a /*! or /*+ comment is read with every word, those in strings and comments included. ' : '');
    throw new SchemaError(withCode('D4', `${reason}Use schema.create(), schema.alter() or schema.raw() instead. See docs/migrations.md#changing-the-data.`));
  };
  // The rules of the driver's own SQL, chosen once: a driver nobody knows is refused here, not read by the rules of another.
  const commits = ((): ((text: string) => boolean) => {
    switch (driver) {
      case 'sqlite':
      case 'pgsql':
        return (text) => sqlChangesSchema(text, driver);
      case 'mysql':
        return (text) => mysqlCommits(text);
      default:
        return unknownDriver(driver);
    }
  })();
  return {
    transformQuery({ node }: PluginTransformQueryArgs): RootOperationNode {
      if (SCHEMA_CHANGES.has(node.kind) || nestsSchemaChange(node)) refuse();
      // The whole query as it is sent, whatever its root: raw SQL appended to a builder query (`modifyEnd(sql.raw('; drop table t'))`) is in it.
      // A query of the builder alone begins with select, insert, update, delete or with, and passes.
      const text = compilerOf(driver).compileQuery(node, createQueryId()).sql;
      if (commits(text)) refuse(driver === 'mysql' ? text : undefined);
      return node;
    },
    transformResult: ({ result }: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> => Promise.resolve(result),
  };
}
