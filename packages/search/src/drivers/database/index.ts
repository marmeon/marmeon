import { ok, type Application, type Resolver, type Result } from '@marmeon/core';
import { withCode } from '@marmeon/core/internal';
import { Connections, SchemaRequirements } from '@marmeon/database';
import { declareDerivedSchema, type DerivedSchemaEntry } from '@marmeon/database/internal';
import type { DriverPage, DriverQuery, SearchDriver, SearchDriverFactory, SearchFailure, SearchKey, StoredDocument } from '../../driver.ts';
import { SearchSetupError } from '../../errors.ts';
import type { IndexInfo } from '../../registry.ts';
import { searchOptions } from '../../config.ts';
import { configFor } from '../../languages.ts';
import { checkConfigurations, queryPgsql } from './pgsql.ts';
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

/**
 * The `database` driver: every index in the table `search_documents` of the default connection, written in the caller's transaction.
 * SQLite searches with FTS5; Postgres with `tsvector`s written by the configuration of each document's locale.
 */
class DatabaseSearchDriver implements SearchDriver {
  readonly writes = 'transaction';
  readonly #connections: Connections;
  readonly #container: Resolver;
  /** The language map of the app, read at the first use on Postgres. */
  #languages: ReadonlyMap<string, string> | undefined;
  /** Whether the database has every configuration of the map: checked once, at the first write or search on Postgres. */
  #checked = false;

  constructor(connections: Connections, container: Resolver) {
    this.#connections = connections;
    this.#container = container;
  }

  /** The default connection: inside a transaction of the caller, its statements join it. */
  get #db() {
    return this.#connections.get('default');
  }

  get #postgres(): boolean {
    return (this.#connections.options('default').driver as string) === 'pgsql';
  }

  /** The language map, after the database confirmed it has each of its configurations (Q9 with the missing names otherwise). */
  async #map(): Promise<ReadonlyMap<string, string>> {
    this.#languages ??= searchOptions(this.#container).languages;
    if (!this.#checked) {
      await checkConfigurations(this.#db, this.#languages);
      this.#checked = true;
    }
    return this.#languages;
  }

  async upsert(index: IndexInfo, documents: readonly StoredDocument[]): Promise<void> {
    if (!this.#postgres) return upsertDocuments(this.#db, index, documents);
    const map = await this.#map();
    await upsertDocuments(this.#db, index, documents, (locale) => configFor(locale, map));
  }

  async delete(index: IndexInfo, keys: readonly SearchKey[]): Promise<void> {
    await deleteDocuments(this.#db, index, keys);
  }

  /** Never an `err`: an error of the app's own database throws like any other query of the app (`unavailable` is for external services). */
  async query(request: DriverQuery): Promise<Result<DriverPage, SearchFailure>> {
    if (!this.#postgres) return ok(await querySqlite(this.#db, request));
    return ok(await queryPgsql(this.#db, request, await this.#map()));
  }

  async flush(index: IndexInfo): Promise<void> {
    await flushDocuments(this.#db, index);
  }

  /**
   * Refuses a database the driver has no SQL for, keeps the language map on Postgres, and makes `/up/ready` red until the table has
   * every column it uses. Connects to nothing: the configurations are checked at the first use.
   */
  async boot(app: Application): Promise<void> {
    const driver = this.#connections.options('default').driver as string;
    if (driver === 'mysql') {
      throw setup('SEARCH_DRIVER=database does not run on MySQL, and the default database connection is a MySQL one. Use SEARCH_DRIVER=meilisearch.');
    }
    if (driver !== 'sqlite' && driver !== 'pgsql') throw setup(`SEARCH_DRIVER=database has no SQL for the database driver ${JSON.stringify(driver)}. Use SQLite or Postgres, or select another driver.`);
    if (driver === 'pgsql') this.#languages = searchOptions(app.container).languages;
    app.container.make(SchemaRequirements).require({ connection: 'default', table: DOCUMENTS_TABLE, columns: DOCUMENTS_COLUMNS, secrets: TEXT_COLUMNS });
  }
}

/** The `database` driver: the index lives in a table of the app's database. See `docs/full-text-search.md#the-database-driver`. */
export const databaseDriver: SearchDriverFactory = ({ container }) => new DatabaseSearchDriver(container.make(Connections), container);

/**
 * Tells the migrator which schema objects the search table derives; called at every start, whatever the driver. It also reads the
 * app's search options, so a second `defineSearch()` stops every start, not only one on Postgres.
 */
export function declareSearchSchema(app: Application): void {
  declareDerivedSchema(app, '@marmeon/search', DERIVED_SCHEMA);
  searchOptions(app.container);
}
