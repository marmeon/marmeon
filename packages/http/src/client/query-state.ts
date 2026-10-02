/**
 * Typed URL state (E55): the query of the page on screen, as its request's `query` schema parsed it on the server
 * (`PageObject.query`, `PageObject.queryDefaults`), changed by visits of the same page. UI-free — an adapter's
 * `useQueryState` renders `value(page)` and calls `set()`. The browser never parses a URL: what it shows is what the
 * server parsed, or what is being typed into it right now.
 *
 * The state (`QueryState`) is a feature (`features/query-state.ts`): in an app only when it uses it (`useQueryState`); the
 * helpers here are what links and islands need of a page's query too.
 */
import { matchesPath, toSearchParams, type PageObject, type Query } from '../page.ts';
import type { Navigator, VisitOptions } from './navigation.ts';

export interface QueryStateOptions {
  /** A partial reload of these props (the rest of the page stays as it is). Without: every prop comes again. */
  only?: readonly string[];
  /** A partial reload of every prop but these. */
  except?: readonly string[];
  /**
   * Props to replace instead of merging (`merge()`/`deepMerge()` props): by default those of `only` — another query is
   * another list, never more of the one on screen ("load more" keeps its own `<Link preserveUrl>`).
   */
  reset?: readonly string[];
  /** Wait this long (ms) after the last change before asking the server — one request per pause while typing. Default 0. */
  debounce?: number;
  /** A history entry per change (`'push'`, the default — Back undoes a sort) or one for all of them (`'replace'`, typing). */
  history?: 'push' | 'replace';
  /** Keep the scroll position (default true). */
  preserveScroll?: boolean;
}

/** A change of the query: some fields (`undefined` takes one back to its default), or a function of the current state. */
export type QueryUpdate<Q> = { readonly [K in keyof Q]?: Q[K] | undefined } | ((current: Q) => { readonly [K in keyof Q]?: Q[K] | undefined });

/** The page's query with its defaults filled in — what its controller saw as `ctx.query`. */
export function pageQuery(page: Pick<PageObject, 'query' | 'queryDefaults'>): Record<string, unknown> {
  return { ...page.queryDefaults, ...page.query };
}

/** `values` without the fields that are just their default (and without `undefined`) — what a URL needs to carry. */
export function withoutDefaults(values: Readonly<Record<string, unknown>>, defaults: Readonly<Record<string, unknown>> = {}): Query {
  const query: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null) continue;
    if (Object.hasOwn(defaults, key) && JSON.stringify(value) === JSON.stringify(defaults[key])) continue;
    query[key] = value;
  }
  return query as Query;
}

/** The URL of the page on screen with `values` as its query (defaults left out; values as `String()`, lists as repeated keys). */
export function queryUrl(page: Pick<PageObject, 'url' | 'queryDefaults'>, values: Readonly<Record<string, unknown>>): string {
  const pathname = new URL(page.url, 'http://bespoke.invalid').pathname;
  const search = toSearchParams(withoutDefaults(values, page.queryDefaults)).toString();
  return search ? `${pathname}?${search}` : pathname;
}

/**
 * The query of a link to `url` (built without a query): for the page on screen — the same path — without the fields
 * that are just its defaults (`<Link query={{ ...query, sort: '-name' }}>` writes no `q=`); for any other page as given.
 */
export function linkQuery(page: Pick<PageObject, 'url' | 'queryDefaults'>, url: string, query: Query): Query {
  if (!page.queryDefaults) return query;
  const base = 'http://bespoke.invalid';
  return new URL(url, base).pathname === new URL(page.url, base).pathname ? withoutDefaults(query, page.queryDefaults) : query;
}

/**
 * Whether the page on screen is one of route `name` (pattern `path`) with a query schema — query state belongs to its
 * route's page. Throws a message saying which of the two it is not.
 */
export function assertQueryPage(name: string, path: string, page: Pick<PageObject, 'url' | 'queryDefaults'>): void {
  const pathname = new URL(page.url, 'http://bespoke.invalid').pathname;
  if (!matchesPath(path, pathname)) {
    throw new Error(`Query state of [${name}] (${path}) is used on ${pathname}, a page of another route — it belongs to the page of its route.`);
  }
  if (!page.queryDefaults) {
    throw new Error(`Route [${name}] has no query schema to keep state in — give its controller \`static request = defineRequest({ query })\`.`);
  }
}

/** A query as a stable key: its URL form, sorted (the order of fields changes nothing). */
function keyOf(values: Readonly<Record<string, unknown>>, defaults: PageObject['queryDefaults']): string {
  const search = toSearchParams(withoutDefaults(values, defaults));
  search.sort();
  return search.toString();
}

/**
 * The query state of the page on screen. `set()` changes it at once (a typed input shows what is typed — the
 * `draft`) and, after `debounce` ms, visits the page's URL with the new query: partially (`only`), keeping component
 * state and scroll, pushing or replacing the history entry. The draft gives way to the page when the page changes for
 * any other reason — Back/Forward, a link — so what the state shows is always this page's query.
 */
export class QueryState<Q extends Record<string, unknown> = Record<string, unknown>> {
  readonly #navigator: Pick<Navigator, 'page' | 'subscribe' | 'visit'>;
  /** The latest options (an adapter passes them again on every render). */
  options: QueryStateOptions;
  #draft: Q | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  /** Visits of this state still under way. */
  #pending = 0;
  /** The query (key) of the page this state's last visit ended on — a page change to it is the answer, not a move away. */
  #answered: string | undefined;
  readonly #listeners = new Set<() => void>();
  readonly #stop: () => void;

  constructor(navigator: Pick<Navigator, 'page' | 'subscribe' | 'visit'>, options: QueryStateOptions = {}) {
    this.#navigator = navigator;
    this.options = options;
    this.#stop = navigator.subscribe(() => this.#onPage());
  }

  /** What is being changed and not yet shown by a page — undefined when the state is the page's query. */
  get draft(): Q | undefined {
    return this.#draft;
  }

  /** The state for `page` (the page on screen): the draft, else the page's query with its defaults. */
  value(page: Pick<PageObject, 'query' | 'queryDefaults'> = this.#navigator.page): Q {
    return this.#draft ?? (pageQuery(page) as Q);
  }

  /** Changes the state now and the URL after `debounce` ms. `undefined` takes a field back to its default. */
  set(update: QueryUpdate<Q>): void {
    const current = this.value();
    const patch = typeof update === 'function' ? update(current) : update;
    const next = { ...current } as Record<string, unknown>;
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) {
        const defaults = this.#navigator.page.queryDefaults ?? {};
        if (Object.hasOwn(defaults, key)) next[key] = defaults[key];
        else delete next[key];
      } else {
        next[key] = value;
      }
    }
    this.#draft = next as Q;
    this.#notify();
    clearTimeout(this.#timer);
    const debounce = this.options.debounce ?? 0;
    if (debounce > 0) {
      this.#timer = setTimeout(() => {
        this.#timer = undefined;
        void this.#send();
      }, debounce);
    } else {
      this.#timer = undefined;
      void this.#send();
    }
  }

  /** Sends a change still waiting for its pause now. */
  flush(): void {
    if (this.#timer === undefined) return;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    void this.#send();
  }

  /** Listens to changes of the draft (for an adapter's re-render). Returns the function that stops it. */
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  };

  /** Stops following the page; a change still waiting for its pause is dropped. */
  dispose(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#stop();
    this.#listeners.clear();
  }

  async #send(): Promise<void> {
    const draft = this.#draft;
    if (draft === undefined) return;
    const page = this.#navigator.page;
    const { only, except, reset, history = 'push', preserveScroll = true } = this.options;
    const options: VisitOptions = {
      replace: history === 'replace',
      preserveState: true,
      preserveScroll,
      ...(only ? { only } : {}),
      ...(except ? { except } : {}),
      ...(reset ?? only ? { reset: reset ?? only } : {}),
    };
    this.#pending++;
    let landed: PageObject | undefined;
    try {
      landed = await this.#navigator.visit(queryUrl(page, draft), options);
    } finally {
      this.#pending--;
    }
    if (landed) this.#answered = keyOf(pageQuery(landed), landed.queryDefaults);
    // Cancelled by Back/Forward, say: the page moved on without this state.
    this.#onPage();
  }

  #onPage(): void {
    if (this.#draft === undefined || this.#timer !== undefined || this.#pending > 0) return;
    const page = this.#navigator.page;
    if (keyOf(pageQuery(page), page.queryDefaults) === this.#answered) return;
    this.#draft = undefined;
    this.#notify();
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }
}
