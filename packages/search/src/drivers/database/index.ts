import { ok, type Application, type Result } from '@marmeon/core';
import { withCode } from '@marmeon/core/internal';
import { Connections, SchemaRequirements } from '@marmeon/database';
import { declareDerivedSchema, type DerivedSchemaEntry } from '@marmeon/database/internal';
import type { DriverPage, DriverQuery, SearchDriver, SearchDriverFactory, SearchFailure, SearchKey, StoredDocument } from '../../driver.ts';
import { SearchSetupError } from '../../errors.ts';
import type { IndexInfo } from '../../registry.ts';
import { querySqlite } from './sqlite.ts';
import { deleteDocuments, DOCUMENTS_COLUMNS, DOCUMENTS_TABLE, flushDocuments, TEXT_COLUMNS, upsertDocuments } from './statements.ts';

/**
 * What the stub migration makes with raw SQL: the FTS5 table on SQLite (its shadow tables with it) and the `vector` column on
 * Postgres. `migrate` does not name them; `db:query` and the database MCP still withhold them.
 */
const DERIVED_SCHEMA: DerivedSchemaEntry = { tables: ['search_documents_fts'], columns: { search_documents: ['vector'] } };

function setup(message: string): SearchSetupError {
  return new SearchSetupError(withCode('Q9', message));
}

/** The `database` driver: every index in the table `search_documents` of the default connection, written in the caller's transaction. */
class DatabaseSearchDriver implements SearchDriver {
  readonly writes = 'transaction';
  readonly #connections: Connections;

  constructor(connections: Connections) {
    this.#connections = connections;
  }

  /** The default connection: inside a transaction of the caller, its statements join it. */
  get #db() {
    return this.#connections.get('default');
  }

  async upsert(index: IndexInfo, documents: readonly StoredDocument[]): Promise<void> {
    await upsertDocuments(this.#db, index, documents);
  }

  async delete(index: IndexInfo, keys: readonly SearchKey[]): Promise<void> {
    await deleteDocuments(this.#db, index, keys);
  }

  /** Never an `err`: an error of the app's own database throws like any other query of the app (`unavailable` is for external services). */
  async query(request: DriverQuery): Promise<Result<DriverPage, SearchFailure>> {
    return ok(await querySqlite(this.#db, request));
  }

  async flush(index: IndexInfo): Promise<void> {
    await flushDocuments(this.#db, index);
  }

  /** Refuses a database the driver has no SQL for, and makes `/up/ready` red until the table has every column it uses. */
  async boot(app: Application): Promise<void> {
    const driver = this.#connections.options('default').driver as string;
    if (driver === 'mysql') {
      throw setup('SEARCH_DRIVER=database does not run on MySQL, and the default database connection is a MySQL one. Use SEARCH_DRIVER=meilisearch.');
    }
    if (driver !== 'sqlite') throw setup(`SEARCH_DRIVER=database on ${JSON.stringify(driver)} is not built in this version of @marmeon/search. Use SQLite, or select another driver.`);
    app.container.make(SchemaRequirements).require({ connection: 'default', table: DOCUMENTS_TABLE, columns: DOCUMENTS_COLUMNS, secrets: TEXT_COLUMNS });
  }
}

/** The `database` driver: the index lives in a table of the app's database. See `docs/full-text-search.md#the-database-driver`. */
export const databaseDriver: SearchDriverFactory = ({ container }) => new DatabaseSearchDriver(container.make(Connections));

/** Tells the migrator which schema objects the search table derives; called at every start, whatever the driver. */
export function declareSearchSchema(app: Application): void {
  declareDerivedSchema(app, '@marmeon/search', DERIVED_SCHEMA);
}
