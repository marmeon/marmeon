import { Application, Clock, Logger, type Container, type Resolver, type ServiceProvider } from '@marmeon/core';
import { collectDrivers, withCode } from '@marmeon/core/internal';
import { Connections, SchemaRequirements, type ProviderMigrations } from '@marmeon/database';
import type { AppCheckClass, CommandClass } from 'marmeon';
import { SearchIndexesCheck } from './check.ts';
import { SearchFlushCommand } from './commands/flush.ts';
import { SearchRebuildCommand } from './commands/rebuild.ts';
import { BUILT_IN_SEARCH_DRIVERS, SearchConfig } from './config.ts';
import { SearchDriver, type SearchDriverFactory } from './driver.ts';
import { databaseDriver, declareSearchSchema } from './drivers/database/index.ts';
import { meilisearchDriver } from './drivers/meilisearch/index.ts';
import { SearchSetupError } from './errors.ts';
import { Rebuilder, rebuildTarget } from './rebuild.ts';
import { SearchIndexes } from './registry.ts';
import { IndexReader, Search, type SyncPayload } from './search.ts';
import type { SearchIndexClass } from './search-index.ts';
import { SyncSearchDocuments } from './sync-job.ts';

declare module '@marmeon/core' {
  interface ModuleDefinition {
    /**
     * The module's search indexes — classes that extend `SearchIndex`, checked at the start. A value that is no list of index classes, a
     * broken definition or a name two classes share stops the start (Q9). See `docs/full-text-search.md#defining-an-index`.
     */
    readonly searchIndexes?: readonly SearchIndexClass[];
  }

  interface ServiceProviderClass {
    /**
     * The search indexes this provider brings, checked and registered like a module's. A value that is no list of index classes, a broken definition
     * or a name two classes share stops the start (Q9). See `docs/full-text-search.md#defining-an-index`.
     */
    readonly searchIndexes?: readonly SearchIndexClass[];
    /**
     * Search drivers this provider brings, by name — `SEARCH_DRIVER=<name>` selects one. A built-in name (`database`, `meilisearch`), a
     * malformed name or a name another provider brings stops the start (Q9). See `docs/drivers.md#search-drivers`.
     */
    readonly searchDrivers?: Readonly<Record<string, SearchDriverFactory>>;
  }
}

function setup(message: string, options?: { cause?: unknown }): SearchSetupError {
  return new SearchSetupError(withCode('Q9', message), options);
}

const BUILT_IN_FACTORIES: Readonly<Record<(typeof BUILT_IN_SEARCH_DRIVERS)[number], SearchDriverFactory>> = { database: databaseDriver, meilisearch: meilisearchDriver };
/** Every column of `search_rebuilds` that a rebuild and the job read or write. */
const REBUILD_COLUMNS = ['index_name', 'run', 'phase', 'after', 'target', 'holder', 'held_until', 'started_at', 'fingerprint'] as const;
const WRITE_MODES: readonly unknown[] = ['transaction', 'queue', 'after-commit'];
const REQUIRED_MEMBERS = ['upsert', 'delete', 'query', 'flush'] as const;
const OPTIONAL_MEMBERS = ['boot', 'prepare', 'swap', 'discard', 'inspect', 'close'] as const;

/** Checks what a factory returned against the driver contract; a broken driver stops the start (Q9). */
function checkDriver(driver: unknown, name: string): SearchDriver {
  const record = (typeof driver === 'object' && driver !== null ? driver : undefined) as Record<string, unknown> | undefined;
  if (record === undefined) throw setup(`The search driver "${name}" must return a SearchDriver object, got ${driver === null ? 'null' : typeof driver}.`);
  if (!WRITE_MODES.includes(record['writes'])) throw setup(`The search driver "${name}" must declare writes as 'transaction', 'queue' or 'after-commit'.`);
  for (const member of REQUIRED_MEMBERS) {
    if (typeof record[member] !== 'function') throw setup(`The search driver "${name}" has no ${member}() method: a SearchDriver has upsert(), delete(), query() and flush().`);
  }
  for (const member of OPTIONAL_MEMBERS) {
    if (record[member] !== undefined && typeof record[member] !== 'function') throw setup(`The search driver "${name}" has a ${member} that is no method: define ${member}() as a method, or leave it out.`);
  }
  // Only the queued job copies changes into a rebuild target: a driver that writes another way would lose every change made while a
  // rebuild runs, at the swap.
  if (record['swap'] !== undefined && record['writes'] !== 'queue') throw setup(`The search driver "${name}" has swap() but writes '${String(record['writes'])}': a driver with swap() writes through the queue (writes: 'queue').`);
  return driver as SearchDriver;
}

type QueueModule = typeof import('@marmeon/queue');

/**
 * @internal @marmeon/queue is an optional peer: only a driver that writes through the queue needs it. `undefined` only when the package
 * itself is missing — the importer's path may name it in the error of another missing package. `load` is the import, replaceable by a test.
 */
export async function importQueue(load: () => Promise<QueueModule> = () => import('@marmeon/queue')): Promise<QueueModule | undefined> {
  try {
    return await load();
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ERR_MODULE_NOT_FOUND' && /Cannot find (?:package|module) '@marmeon\/queue'/.test(String((error as Error).message))) return undefined;
    throw error;
  }
}

/** The registry of every index of the modules and the providers, checked as it is filled. */
function collectIndexes(app: Application): SearchIndexes {
  const indexes = new SearchIndexes();
  for (const module of app.modules) indexes.add(module.searchIndexes, `module ${module.name}`);
  for (const Provider of app.providers) {
    const { name } = Provider as { readonly name?: unknown };
    indexes.add(Provider.searchIndexes, `provider ${typeof name === 'string' && name !== '' ? name : '(unnamed)'}`);
  }
  return indexes;
}

/**
 * Registers search: `SEARCH_DRIVER` selects the driver, built and checked at the start, and a name nobody brought stops the start;
 * the indexes of the modules and the providers are checked at the start; `Search` keeps them current and searches them. With
 * @marmeon/queue, the job `marmeon.search.sync` is registered. Found by `marmeon discover`. See `docs/full-text-search.md#configuration`.
 */
export class SearchServiceProvider implements ServiceProvider {
  static config = [SearchConfig];
  /** The tables of `SEARCH_DRIVER=database`, copied into an app by `marmeon publish @marmeon/search`. */
  static migrations = { from: new URL('../stubs/migrations', import.meta.url), module: 'system' } satisfies ProviderMigrations;
  static commands: readonly CommandClass[] = [SearchRebuildCommand, SearchFlushCommand];
  /** `search-indexes` for `marmeon check`: what the selected driver's `inspect()` finds missing or different. See `docs/check.md#the-app-checks`. */
  static checks: readonly AppCheckClass[] = [SearchIndexesCheck];

  /** The driver, once built — closed at shutdown. */
  #driver: SearchDriver | undefined;
  /** @marmeon/queue, loaded at boot when the app has it bound. */
  #queue: QueueModule | undefined;

  /** The drivers other providers bring; a malformed name, a built-in name or a name twice stops the start. */
  #factories(container: Resolver): ReadonlyMap<string, SearchDriverFactory> {
    try {
      return collectDrivers<SearchDriverFactory>(container.make(Application).providers, 'searchDrivers', BUILT_IN_SEARCH_DRIVERS, 'search driver');
    } catch (error) {
      // collectDrivers refuses a broken record with a TypeError; Q9 is the one code of every search setup error.
      if (error instanceof TypeError) throw setup(error.message, { cause: error });
      throw error;
    }
  }

  #unknown(driver: string, container: Resolver): SearchSetupError {
    return setup(`SEARCH_DRIVER=${driver} is not a search driver. Known: ${[...BUILT_IN_SEARCH_DRIVERS, ...this.#factories(container).keys()].join(', ')}.`);
  }

  register(container: Container): void {
    container.singleton(SearchIndexes, (c) => collectIndexes(c.make(Application)));
    container.singleton(SearchDriver, (c) => {
      const name = c.make(SearchConfig).driver;
      const factory = Object.hasOwn(BUILT_IN_FACTORIES, name) ? BUILT_IN_FACTORIES[name as keyof typeof BUILT_IN_FACTORIES] : this.#factories(c).get(name);
      if (factory === undefined) throw this.#unknown(name, c);
      this.#driver = checkDriver(factory({ name, container: c, logger: c.make(Logger).child({ channel: 'search' }) }), name);
      return this.#driver;
    });
    container.singleton(IndexReader, (c) => new IndexReader(c.make(SearchIndexes), c));
    const dispatch = async (payload: SyncPayload): Promise<unknown> => {
      const module = this.#queue;
      // boot() loads the queue for a queue driver or stops the start; unset means something dispatched before it.
      if (module === undefined) throw setup('The search driver writes through the queue, but @marmeon/queue is not set up (marmeon add queue; if it is installed already: marmeon discover).');
      return container.make(module.Queue).dispatch(SyncSearchDocuments, payload);
    };
    container.singleton(Search, (c) => new Search({ indexes: c.make(SearchIndexes), reader: c.make(IndexReader), driver: () => c.make(SearchDriver), connections: () => c.make(Connections), dispatch }));
    container.bind(SyncSearchDocuments, (c) => new SyncSearchDocuments(c.make(SearchIndexes), c.make(IndexReader), c.make(SearchDriver), c.make(Clock), (index) => rebuildTarget(c.make(Connections), index)));
    container.bind(
      Rebuilder,
      (c) => new Rebuilder({ indexes: c.make(SearchIndexes), reader: c.make(IndexReader), driver: () => c.make(SearchDriver), connections: () => c.make(Connections), container: c, clock: c.make(Clock) }),
    );
  }

  async boot(app: Application): Promise<void> {
    // A broken index definition stops the start here, not at the first search.
    app.container.make(SearchIndexes);
    declareSearchSchema(app);
    const config = app.container.make(SearchConfig);
    const custom = this.#factories(app.container);
    if (!(BUILT_IN_SEARCH_DRIVERS as readonly string[]).includes(config.driver) && !custom.has(config.driver)) throw this.#unknown(config.driver, app.container);
    // The selected driver is built now: a factory that fails, or a driver that breaks the contract, stops the start.
    const driver = app.container.make(SearchDriver);
    const queue = await importQueue();
    if (queue && app.container.has(queue.Queue) && app.container.has(queue.JobRegistry)) {
      this.#queue = queue;
      app.container.make(queue.JobRegistry).add([SyncSearchDocuments], '@marmeon/search', { framework: true });
    } else if (driver.writes === 'queue') {
      throw setup(`The search driver "${config.driver}" writes through the queue, which needs @marmeon/queue (marmeon add queue; if it is installed already: marmeon discover; if the app does not boot yet: pnpm add -E @marmeon/queue@<version of your app>).`);
    }
    // A driver with swap() writes through the queued job, which looks up a rebuild target in search_rebuilds for every change:
    // without the table no change reaches the index, so /up/ready stays red until it is migrated.
    if (driver.swap !== undefined && app.container.has(SchemaRequirements)) app.container.make(SchemaRequirements).require({ connection: 'default', table: 'search_rebuilds', columns: REBUILD_COLUMNS });
    await driver.boot?.(app);
  }

  async shutdown(): Promise<void> {
    await this.#driver?.close?.();
  }
}
