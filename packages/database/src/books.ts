import { withCode } from '@marmeon/core/internal';
import { OperationNodeTransformer, type Kysely, type KyselyPlugin, type PluginTransformQueryArgs, type PluginTransformResultArgs, type QueryResult, type RootOperationNode, type TableNode, type UnknownRow } from 'kysely';
import { isBookkeepingName } from './bookkeeping.ts';
import type { Connections } from './connections.ts';
import { SchemaError } from './schema/schema-error.ts';

// How the migrator reaches the bookkeeping of a database whose bookkeeping the app's connection refuses. Not API: only the migrator
// imports it, and it is not exported from the package.

const BOOKS = new WeakMap<object, Map<string, Kysely<any>>>();

/** Called by {@link Connections} for each connection it opens. */
export function registerBookkeeping(connections: object, name: string, db: Kysely<any>): void {
  let byName = BOOKS.get(connections);
  if (!byName) BOOKS.set(connections, (byName = new Map()));
  byName.set(name, db);
}

/**
 * The connection the migrator keeps its bookkeeping with. Unlike `connections.get()` it works on a database whose bookkeeping the
 * app's connection refuses to read (that refusal is what it is there to repair), and it refuses every table that is not the
 * migrator's — it resolves no placeholders and plans no relations.
 */
export function bookkeepingConnection(connections: Connections, name = 'default'): Kysely<any> {
  connections.get(name); // opens the connection's entry
  return BOOKS.get(connections)!.get(name)!;
}

/** Schemas that `Kysely` itself reads for the catalog: allowed on the bookkeeping connection. */
const CATALOG = new Set(['pg_catalog', 'information_schema']);
const CATALOG_TABLES = new Set(['sqlite_master', 'sqlite_schema']);
const DATA = new Set(['SelectQueryNode', 'InsertQueryNode', 'UpdateQueryNode', 'DeleteQueryNode', 'MergeQueryNode']);
const WRITES = new Set(['InsertQueryNode', 'UpdateQueryNode', 'DeleteQueryNode', 'MergeQueryNode']);

/** The last segment of a table's name: `public.marmeon_secret_columns` and `marmeon_secret_columns` are one table. */
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

/** On the bookkeeping connection: a statement on any table but the migrator's (or the catalog) throws before it is sent. Raw SQL is not looked into. */
export function onlyBookkeeping(): KyselyPlugin {
  return new Plugin(DATA, (table) => {
    const name = lastSegment(table.table.identifier.name);
    const schema = table.table.schema?.name;
    if (isBookkeepingName(name) || CATALOG_TABLES.has(name) || (schema !== undefined && CATALOG.has(schema))) return;
    throw new Error(`The migrator's bookkeeping connection reads and writes the migrator's tables only; "${name}" is not one of them.`);
  });
}

/** On `schema.db` in a migration: a write to the migrator's tables throws before it is sent. Raw SQL is not looked into. */
export function noBookkeepingWrites(): KyselyPlugin {
  return new Plugin(WRITES, (table) => {
    const name = lastSegment(table.table.identifier.name);
    if (!isBookkeepingName(name)) return;
    throw new SchemaError(
      withCode('D4', `Cannot write to "${name}": the table belongs to the migrator's bookkeeping, and changing it by hand would make the secret columns or the soft deletes unreadable. See docs/migrations.md#how-the-migrator-keeps-track.`),
    );
  });
}

/** The `Schema`s the migrator itself made: they may change its own tables. Nobody else holds one of these. */
export const bookkeepingAccess = new WeakSet<object>();
