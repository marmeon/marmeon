import { CompiledQuery, TableNode, type DatabaseConnection, type KyselyPlugin, type PluginTransformQueryArgs, type PluginTransformResultArgs, type QueryResult, type RootOperationNode, type UnknownRow } from 'kysely';
import type { Driver } from './schema/blueprint.ts';

/** Internal bookkeeping: the columns migrations marked `.secret()` (written by the migrator). */
export const SECRETS_TABLE = 'secret_columns';

/** How a column's values must be converted when they arrive inside nested JSON (relations). */
export type ColumnKind = 'boolean' | 'json' | 'timestamp' | { decimal: number } | 'other';

/**
 * What the connection knows about its schema: column kinds (for relations) and secret columns.
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
  #stale = true;
  #loading: Promise<void> | undefined;

  constructor(driver: Driver) {
    this.#driver = driver;
  }

  /** Table → column → kind, as declared (SQLite) or reported (Postgres). */
  get kinds(): ReadonlyMap<string, ReadonlyMap<string, ColumnKind>> {
    return this.#kinds;
  }

  /** Table → its secret columns. */
  get secrets(): ReadonlyMap<string, ReadonlySet<string>> {
    return this.#secrets;
  }

  invalidate(): void {
    this.#stale = true;
  }

  /** Loads what is stale, on `connection` — called by the driver whenever it hands out a connection. */
  refresh(connection: DatabaseConnection): Promise<void> {
    if (!this.#stale) return Promise.resolve();
    this.#loading ??= this.#load(connection).finally(() => (this.#loading = undefined));
    return this.#loading;
  }

  /** Marks the metadata stale whenever a query changes the schema or the secret-column bookkeeping. */
  plugin(): KyselyPlugin {
    return {
      transformQuery: ({ node }: PluginTransformQueryArgs): RootOperationNode => {
        if (changesSchema(node)) this.invalidate();
        return node;
      },
      transformResult: async ({ result }: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> => result,
    };
  }

  async #load(connection: DatabaseConnection): Promise<void> {
    // Stale from here on only if a schema change happens while loading.
    this.#stale = false;
    try {
      const run = async <R>(sql: string) => (await connection.executeQuery<R>(CompiledQuery.raw(sql))).rows;
      const columns =
        this.#driver === 'sqlite'
          ? await run<ColumnRow>(`select m.name as table_name, p.name as column_name, lower(p.type) as type
              from sqlite_master m join pragma_table_info(m.name) p where m.type = 'table'`)
          : await run<ColumnRow>(`select table_name, column_name,
              case when data_type = 'numeric' then 'numeric(' || coalesce(numeric_precision, 0) || ', ' || coalesce(numeric_scale, 0) || ')' else udt_name end as type
              from information_schema.columns where table_schema = current_schema()`);
      const kinds = new Map<string, Map<string, ColumnKind>>();
      for (const { table_name, column_name, type } of columns) {
        let table = kinds.get(table_name);
        if (!table) kinds.set(table_name, (table = new Map()));
        table.set(column_name, kindOf(type));
      }

      // The bookkeeping table exists once a migration ran. Checked first: on Postgres a failing query
      // would abort the transaction it runs in (tests run inside one).
      const secrets = new Map<string, Set<string>>();
      if (kinds.has(SECRETS_TABLE)) {
        for (const { table_name, column_name } of await run<{ table_name: string; column_name: string }>(`select table_name, column_name from ${SECRETS_TABLE}`)) {
          let table = secrets.get(table_name);
          if (!table) secrets.set(table_name, (table = new Set()));
          table.add(column_name);
        }
      }
      this.#kinds = kinds;
      this.#secrets = secrets;
    } catch (error) {
      this.#stale = true;
      throw error;
    }
  }
}

interface ColumnRow {
  table_name: string;
  column_name: string;
  type: string;
}

function kindOf(type: string): ColumnKind {
  const decimal = /^(?:numeric|decimal)\(\s*\d+\s*,\s*(\d+)\s*\)$/.exec(type);
  if (decimal) return { decimal: Number(decimal[1]) };
  if (type === 'boolean' || type === 'bool') return 'boolean';
  if (type === 'json' || type === 'jsonb') return 'json';
  if (type === 'datetime' || type.startsWith('timestamp')) return 'timestamp';
  return 'other';
}

const DDL = new Set(['CreateTableNode', 'AlterTableNode', 'DropTableNode']);

function changesSchema(node: RootOperationNode): boolean {
  // Raw DDL (`sql\`alter table …\``) is not recognized — like before, the next blueprint change reloads.
  if (DDL.has(node.kind)) return true;
  if (node.kind !== 'InsertQueryNode' && node.kind !== 'UpdateQueryNode' && node.kind !== 'DeleteQueryNode') return false;
  const target = node.kind === 'InsertQueryNode' ? node.into : node.kind === 'UpdateQueryNode' ? node.table : node.from.froms[0];
  return target !== undefined && TableNode.is(target) && target.table.identifier.name === SECRETS_TABLE;
}
