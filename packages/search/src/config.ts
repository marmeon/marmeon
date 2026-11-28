import { Application, defineConfig, env, type ConfigDefinition, type ConfigOf, type Resolver } from '@marmeon/core';
import { configDefinitions, withCode } from '@marmeon/core/internal';
import { SearchSetupError } from './errors.ts';
import { languageMap } from './languages.ts';

/** The drivers the package ships; a provider can bring more (`static searchDrivers`). */
export const BUILT_IN_SEARCH_DRIVERS = ['database', 'meilisearch'] as const;

/** The environment of search; see `docs/full-text-search.md#configuration`. */
export const SearchConfig = defineConfig('search', {
  env: env({
    /**
     * `database` (default: the index lives in a table of the app's database, no other service), `meilisearch` (a Meilisearch server,
     * through @marmeon/fetch and @marmeon/queue) or a driver a provider brings. A name nobody brought stops the start.
     */
    SEARCH_DRIVER: env.string().regex(/^[a-z][a-z0-9-]*$/, 'must be a driver name: lowercase letters, digits and dashes, starting with a letter').default('database'),
    /** The address of the Meilisearch server, such as `http://127.0.0.1:7700`. Read when `SEARCH_DRIVER=meilisearch`. */
    SEARCH_MEILISEARCH_URL: env.string().default(''),
    /** The Meilisearch API key, read when `SEARCH_DRIVER=meilisearch`. The name contains `API_KEY`, so the log redactor masks it. */
    SEARCH_MEILISEARCH_API_KEY: env.string().default(''),
  }),
  resolve: (e) => ({
    driver: e.SEARCH_DRIVER,
    meilisearch: { url: e.SEARCH_MEILISEARCH_URL, apiKey: e.SEARCH_MEILISEARCH_API_KEY },
  }),
});
export type SearchConfig = ConfigOf<typeof SearchConfig>;

/** What `defineSearch()` resolves to: the language map, the built-in languages with the app's own on top. See `docs/full-text-search.md#languages`. */
export interface SearchOptions {
  readonly languages: ReadonlyMap<string, string>;
}

const DEFINITION: unique symbol = Symbol('marmeon.search.definition');

/** The app's `defineSearch(…)`: a config definition to list in the app's `config`. See `docs/full-text-search.md#languages`. */
export interface SearchDefinition extends ConfigDefinition<SearchOptions> {
  readonly [DEFINITION]: true;
}

const NO_ENV = env({});

function setup(message: string): SearchSetupError {
  return new SearchSetupError(withCode('Q9', message));
}

/**
 * The app's search options, a config definition to list in the app's `config`; an app has one. `languages` maps a locale (`de-CH`)
 * or a language (`de`) to the Postgres text search configuration that reads its documents, on top of the built-in languages. An
 * option other than `languages`, a locale that is no language tag or a malformed configuration name stops the start (Q9) here; a
 * second `defineSearch()` stops the start too; a configuration the database lacks stops the first search or write. See
 * `docs/full-text-search.md#languages`.
 */
export function defineSearch(definition: { readonly languages?: Readonly<Record<string, string>> } = {}): SearchDefinition {
  const prototype: unknown = typeof definition === 'object' && definition !== null ? Object.getPrototypeOf(definition) : undefined;
  if (prototype !== Object.prototype && prototype !== null) throw setup('defineSearch() takes a plain object of options, such as { languages: { "de-CH": "german" } }.');
  const unknown = Reflect.ownKeys(definition).filter((key) => key !== 'languages');
  if (unknown.length > 0) throw setup(`defineSearch() has no option ${unknown.map((key) => JSON.stringify(String(key))).join(', ')}; its one option is languages.`);
  const languages = languageMap(definition.languages);
  return Object.freeze({ ...defineConfig('search', { env: NO_ENV, resolve: (): SearchOptions => ({ languages }) }), [DEFINITION]: true as const });
}

/** @internal */
export function isSearchDefinition(value: unknown): value is SearchDefinition {
  return typeof value === 'object' && value !== null && DEFINITION in value;
}

/**
 * @internal The app's search options: its one `defineSearch(…)`, from the app's, a module's or a provider's `config` (the same
 * definition listed twice counts once), else the built-in languages. Two definitions stop the start (Q9).
 */
export function searchOptions(container: Resolver): SearchOptions {
  const app = container.make(Application);
  const definitions = [...configDefinitions(app.definition, app.modules, app.providers)].filter(isSearchDefinition);
  if (definitions.length > 1) throw setup('The app has more than one defineSearch(…) in its config; keep one.');
  return definitions[0] ? container.make(definitions[0]) : { languages: languageMap() };
}
