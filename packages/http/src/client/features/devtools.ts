/**
 * The data side of the in-page devtools bar, as a feature: every request the client core makes (kind, status, duration, the
 * server's `x-request-id`), the live hints, the optimistic patches and the hydration errors React recovered from.
 * See docs/devtools.md#the-bar-on-every-page.
 *
 * **Development only:** nothing in the framework imports it; the devtools' client attaches it through
 * `__MARMEON_DEVTOOLS_HOOK__`, whose calls a production build drops. What it holds is the server's data — only in slots of the
 * document, emptied when the document is left, never in `history.state` or any storage.
 */
import type {
  ValidationErrors,
} from '../../page.ts';
import {
  ACTION_HEADER,
  LOCATION_HEADER,
  PAGE_HEADER,
  PARTIAL_COMPONENT_HEADER,
  PARTIAL_DATA_HEADER,
  PARTIAL_EXCEPT_HEADER,
  PURPOSE_HEADER,
  REGION_HEADER,
  RELOAD_HEADER,
  UPLOAD_HEADER,
  VALIDATE_HEADER,
} from '../../protocol.ts';
import type { FeatureHost } from '../core.ts';
import { defineFeature, slot, type PendingVisit } from '../feature.ts';
import type { Navigator } from '../navigation.ts';
import { notify } from '../notify.ts';

/** What kind of request a timeline entry is. */
export type TimelineKind =
  /** The document itself (a full load) — seeded by the bar from what the server rendered. */
  | 'document'
  | 'visit'
  /** The page again (`reload`, a form back to its own URL, "load more"). */
  | 'reload'
  /** Some props of the page on screen (`only`/`except`). */
  | 'partial'
  /** A visit in the background (`async`): a poll, `WhenVisible`, a live hint's reload. */
  | 'background'
  /** Deferred props loading after a page showed. */
  | 'deferred'
  | 'prefetch'
  /** Back/Forward to a page memory let go of: the server is asked. */
  | 'restore'
  | 'layer'
  | 'island'
  | 'action'
  /** A live validation. */
  | 'validation'
  | 'upload'
  /** A hint on the live stream — no request of its own: what it reloads follows as a `background` visit or an island's reload. */
  | 'live';

/** How a request ended. */
export type TimelineOutcome =
  | 'ok'
  /** Validation errors came back (a form sent back, a 422). */
  | 'invalid'
  /** A 409: the browser loads `location` fully — a new build, signing in or out (no failure). */
  | 'reload'
  /** A redirect an action reported (not followed). */
  | 'redirect'
  /** 4xx/5xx, or the network failed. */
  | 'failed'
  /** Aborted: a newer visit, Back/Forward, the document left. */
  | 'cancelled'
  /** A visit that took a page fetched ahead — no request of its own. */
  | 'prefetched';

/** One request (or hint) of the timeline — oldest first. Fields fill in as its answer comes. */
export interface TimelineEntry {
  readonly id: number;
  readonly kind: TimelineKind;
  /** `GET`, `POST`, … (`SSE` for a live hint). */
  readonly method: string;
  /** What was asked for — path and query. */
  readonly url: string;
  /** When it started (ms since the epoch). */
  readonly at: number;
  /** When it ended — undefined while under way. */
  end?: number;
  status?: number;
  /** The server's request id (`x-request-id`) — what `/_marmeon/devtools/api/requests/:id` knows of it. */
  requestId?: string;
  /** Where the answer came from after redirects (path and query) — the page it answered with. */
  answered?: string;
  outcome?: TimelineOutcome;
  /** A 409's: where the browser reloads, and why (`version`, `history`). */
  location?: string;
  reload?: string;
  /** A partial reload's props. */
  readonly only?: readonly string[];
  readonly except?: readonly string[];
  /** The route's name, when the visit or action named it. */
  readonly name?: string;
  /** The view it answered with (a page, a layer, an island). */
  component?: string;
  /** The validation errors its answer brought — the server's data. */
  errors?: ValidationErrors;
  /** The optimistic patches shown while it ran (their ids, see `snapshots`). */
  patches?: readonly number[];
  /** A live hint's channel, and the props it named (`null`: every prop following it). */
  readonly channel?: string;
  readonly hinted?: readonly string[] | null;
}

/** One optimistic patch as it was shown: the props it changed — before, and as the patch showed them. */
export interface PatchSnapshot {
  readonly id: number;
  /** The timeline entry of the action or visit it went with. */
  request?: number;
  readonly at: number;
  /** The props it changed, beneath it — once it was first shown. */
  before?: Readonly<Record<string, unknown>>;
  /** What it showed of them. */
  after?: Readonly<Record<string, unknown>>;
  /** `shown` while under way; `committed` — its state became the props (nothing reloaded them); `removed` — rolled back or replaced by the server's props. */
  state: 'shown' | 'committed' | 'removed';
}

/** An error React recovered from while hydrating — a mismatch, or a part that failed on the server. */
export interface HydrationIssue {
  readonly at: number;
  /** The page it happened on. */
  readonly component: string;
  /** The part failed on the server (the browser rendered it) — otherwise the markup did not match. */
  readonly server: boolean;
  readonly message: string;
  readonly stack?: string;
}

/**
 * The dev hook — `globalThis.__MARMEON_DEVTOOLS_HOOK__`, set by the devtools' client before the app starts. The core and the
 * React adapter call it only under `process.env.NODE_ENV === 'development' || … === 'test'` (gone from a production build), each method optional.
 */
export interface DevtoolsHook {
  /** A navigator was made — the bar attaches {@link devtools} to it. */
  navigator(navigator: Navigator): void;
  /** Optimistic patches applied together — one action's, or one visit's (their ids). */
  patches(ids: readonly number[]): void;
  /** A patch was shown: the props beneath it, and what it changed. */
  patched(id: number, beneath: Readonly<Record<string, unknown>>, changed: Readonly<Record<string, unknown>>): void;
  /** Patches folded into the props (their action succeeded, nothing reloads them). */
  committed(ids: Iterable<number>): void;
  /** Patches taken out — rolled back, or replaced by the server's props. */
  removed(ids: Iterable<number>): void;
  /** React recovered from an error while hydrating `component`. */
  recoverable(error: unknown, component: string, server: boolean): void;
}

/** Where the dev hook is (`globalThis`) — the shape the core reads it with. */
export interface DevtoolsGlobal {
  __MARMEON_DEVTOOLS_HOOK__?: Partial<DevtoolsHook>;
}

/** What the bar uses of the feature. Its lists are the slots' — empty again once the document is left. */
export interface DevtoolsFeature {
  /** Every request and hint, oldest first (the last {@link TIMELINE_LIMIT}). */
  readonly timeline: readonly TimelineEntry[];
  /** The optimistic patches shown, oldest first. */
  readonly snapshots: readonly PatchSnapshot[];
  /** Hydration errors React recovered from. */
  readonly hydration: readonly HydrationIssue[];
  /** The document is being left (a 409: signed in or out, a new build) — nothing is shown or kept any more. */
  readonly left: boolean;
  /** What the bar fetched for what it shows (the server's record of a request, where a view is) — gone with the document. */
  readonly cache: Map<string, unknown>;
  /**
   * The answer that showed `url` (a page or a layer — path and query): the latest with every prop (not a partial reload, not
   * deferred props), else the latest at all. Its request id is the server's record of it.
   */
  answerFor(url: string): TimelineEntry | undefined;
  /** Follows every change (batched to a microtask). Returns the function that stops it. */
  subscribe(listener: () => void): () => void;
  /** Runs `listener` once the navigator takes over the history (`start()`) — at once if it has. */
  onStarted(listener: () => void): () => void;
  /**
   * This navigator is not the app's after all (React made another one: a hydration error renders the tree again) — it records
   * nothing more and keeps nothing.
   */
  stop(): void;
  /** What the dev hook reports — and the document's own request, seeded by the bar. */
  readonly record: Omit<DevtoolsHook, 'navigator'> & { document(url: string, requestId: string | undefined): void };
}

/** How many timeline entries are kept — the oldest go first. */
export const TIMELINE_LIMIT = 300;
/** How many patches and hydration errors are kept. */
const LIST_LIMIT = 100;

/** A list in a slot of the document — emptied (its length 0) when the document is left. */
const list = <T>(name: string) => slot(name, (): T[] => [], (items) => void (items.length = 0));

const SNAPSHOTS = list<PatchSnapshot>('devtools-snapshots');
const HYDRATION = list<HydrationIssue>('devtools-hydration');
/** Visits under way, by `METHOD url` — what their request is when it goes out (a visit may take a page fetched ahead instead). */
const VISITS = slot('devtools-visits', () => new Map<string, TimelineEntry>());
/** What the bar fetched (`DevtoolsFeature.cache`). */
const CACHE = slot('devtools-cache', () => new Map<string, unknown>());

/** The kinds of answer that show a page or a layer — what {@link DevtoolsFeature.answerFor} looks for. */
/** The status the document came with — the browser's navigation timing (a 404 page is a 404); 200 where it does not say. */
function documentStatus(): number {
  const [navigation] = (globalThis.performance?.getEntriesByType?.('navigation') ?? []) as { responseStatus?: number }[];
  return navigation?.responseStatus || 200;
}

const PAGE_KINDS: ReadonlySet<TimelineKind> = new Set(['document', 'visit', 'reload', 'partial', 'background', 'deferred', 'prefetch', 'restore', 'layer']);

/** Path and query of a URL (absolute or not). */
function pathOf(url: string, base: string): string {
  try {
    const parsed = new URL(url, base);
    return parsed.pathname + parsed.search;
  } catch {
    return url;
  }
}

/** A header list (`a,b`) as names. */
function names(value: string | null): readonly string[] | undefined {
  return value === null ? undefined : value.split(',').map((name) => name.trim()).filter(Boolean);
}

/** Pushes `item`, dropping the oldest beyond `limit`. */
function keep<T>(items: T[], item: T, limit: number): T {
  items.push(item);
  if (items.length > limit) items.splice(0, items.length - limit);
  return item;
}

/** The kind a visit's request is — from what the visit asked for. */
function visitKind(visit: PendingVisit): TimelineKind {
  if (visit.options.async) return 'background';
  if (visit.layer) return 'layer';
  if (visit.partial) return 'partial';
  // A form sent to its own URL keeps the page too — but it is a visit (a write), not a reload.
  return visit.keeps && visit.method === 'get' ? 'reload' : 'visit';
}

/** The kind of a request the core (or a feature) sent that was no visit — from its headers. */
function requestKind(headers: Headers, url: string): TimelineKind | undefined {
  if (headers.has(VALIDATE_HEADER)) return 'validation';
  if (headers.has(ACTION_HEADER)) return 'action';
  if (headers.has(UPLOAD_HEADER) || url.startsWith('/_marmeon/uploads')) return 'upload';
  if (headers.get(PURPOSE_HEADER) === 'prefetch') return 'prefetch';
  const region = headers.get(REGION_HEADER);
  if (region !== null) return region === 'layer' ? 'layer' : 'island';
  if (headers.get(PAGE_HEADER) !== 'true') return undefined;
  return headers.has(PARTIAL_COMPONENT_HEADER) ? 'deferred' : 'restore';
}

/** The errors of a page's `errors` prop, or of a 422's body — undefined when there are none. */
function errorsOf(body: unknown): ValidationErrors | undefined {
  const errors = (body as { errors?: unknown; props?: { errors?: unknown } } | null)?.props?.errors ?? (body as { errors?: unknown } | null)?.errors;
  return typeof errors === 'object' && errors !== null && Object.keys(errors).length > 0 ? (errors as ValidationErrors) : undefined;
}

/**
 * The devtools' data, as a feature: attached by the devtools' client through the dev hook, never by an app. It wraps
 * the window's `fetch` and `EventSource` (to see every request and live hint), hangs on the visit pipeline (`start`: what a visit
 * asked for), and keeps what it saw in slots of the document only.
 */
export const devtools = defineFeature('devtools', (host: FeatureHost): DevtoolsFeature => {
  const win = host.window as { fetch: FeatureHost['window']['fetch']; EventSource?: new (url: string) => EventSource };
  const listeners = new Set<() => void>();
  let queued = false;
  // The timeline — emptied when the document is left, and then the bar draws again: with nothing of it.
  const TIMELINE = slot(
    'devtools-timeline',
    (): TimelineEntry[] => [],
    (items) => {
      items.length = 0;
      changed();
    },
  );
  const timeline = () => host.document(TIMELINE);
  const snapshots = () => host.document(SNAPSHOTS);
  const changed = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      notify(listeners);
    });
  };
  let next = 0;
  let stopped = false;
  // An entry made in this task — the optimistic patches applied right after it (in the same task) went with it.
  let fresh: TimelineEntry | undefined;
  let waitingPatches: readonly number[] | undefined;
  const add = (entry: Omit<TimelineEntry, 'id' | 'at'>): TimelineEntry => {
    const made: TimelineEntry = keep(timeline(), { id: ++next, at: Date.now(), ...entry }, TIMELINE_LIMIT);
    if (waitingPatches) {
      made.patches = waitingPatches;
      for (const snapshot of snapshots()) if (waitingPatches.includes(snapshot.id)) snapshot.request = made.id;
      waitingPatches = undefined;
    }
    fresh = made;
    queueMicrotask(() => {
      if (fresh === made) fresh = undefined;
    });
    changed();
    return made;
  };
  const visits = () => host.document(VISITS);

  host.on('start', (visit) => {
    const entry = add({
      kind: visitKind(visit),
      method: visit.method.toUpperCase(),
      url: pathOf(visit.url, host.window.location.href),
      ...(visit.options.only ? { only: visit.options.only } : {}),
      ...(visit.options.except ? { except: visit.options.except } : {}),
      ...(visit.options.name !== undefined ? { name: visit.options.name } : {}),
    });
    const key = `${entry.method} ${visit.url}`;
    visits().set(key, entry);
    return {
      // Landed without a request of its own: it took a page fetched ahead.
      landed: () => {
        if (entry.status !== undefined) return;
        entry.outcome = 'prefetched';
        entry.end = Date.now();
        changed();
      },
      end: () => {
        if (visits().get(key) === entry) visits().delete(key);
        if (entry.end === undefined) {
          entry.outcome ??= 'cancelled';
          entry.end = Date.now();
          changed();
        }
      },
    };
  });

  // Every request goes through the window's `fetch` (the core's `send`, islands, actions, uploads): the timeline sees all of them.
  const fetch = win.fetch;
  win.fetch = (input: string, init: RequestInit = {}) => {
    const sent = fetch.call(host.window, input, init);
    if (stopped) return sent;
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    // The core fetches `origin + path`; a visit is keyed by its path.
    const path = pathOf(input, host.window.location.href);
    const visit = visits().get(`${method} ${path}`);
    if (visit) visits().delete(`${method} ${path}`);
    const kind = visit ? undefined : requestKind(headers, path);
    if (!visit && !kind) return sent;
    const entry =
      visit ??
      add({
        kind: kind!,
        method,
        url: path,
        ...(headers.has(PARTIAL_DATA_HEADER) ? { only: names(headers.get(PARTIAL_DATA_HEADER))! } : {}),
        ...(headers.has(PARTIAL_EXCEPT_HEADER) ? { except: names(headers.get(PARTIAL_EXCEPT_HEADER))! } : {}),
      });
    void sent.then(
      (response) => answered(entry, response),
      () => {
        if (host.left) return;
        entry.outcome = init.signal?.aborted ? 'cancelled' : 'failed';
        entry.end = Date.now();
        changed();
      },
    );
    return sent;
  };

  const answered = async (entry: TimelineEntry, response: Response): Promise<void> => {
    if (host.left) return;
    entry.status = response.status;
    entry.end = Date.now();
    entry.requestId = response.headers.get('x-request-id') ?? undefined;
    entry.answered = response.url ? pathOf(response.url, host.window.location.href) : entry.url;
    const location = response.status === 409 ? response.headers.get(LOCATION_HEADER) : null;
    if (location !== null) {
      entry.outcome = 'reload';
      entry.location = location;
      entry.reload = response.headers.get(RELOAD_HEADER) ?? 'history';
    } else if (response.headers.has('x-marmeon-redirect')) {
      entry.outcome = 'redirect';
    } else {
      entry.outcome = response.status === 422 ? 'invalid' : response.status >= 400 || response.status === 0 ? 'failed' : 'ok';
    }
    changed();
    // What it answered with: the view's name — and its validation errors (a page's `errors` prop, a 422's body). Nothing else of it is kept.
    if (!(response.headers.get('content-type') ?? '').includes('json') || response.status === 204) return;
    try {
      const body = (await response.clone().json()) as { component?: unknown } | null;
      if (host.left) return;
      if (typeof body?.component === 'string') entry.component = body.component;
      const errors = errorsOf(body);
      if (errors) {
        entry.errors = errors;
        entry.outcome = 'invalid';
      }
      changed();
    } catch {
      // Not JSON after all: nothing more to show.
    }
  };

  // Live hints: the stream is the live feature's; a hint is seen where it arrives.
  const Source = win.EventSource;
  if (Source) {
    win.EventSource = class extends Source {
      constructor(url: string) {
        super(url);
        this.addEventListener('refresh', (event) => {
          if (host.left || stopped) return;
          try {
            const hint = JSON.parse((event as MessageEvent<string>).data) as { channel: string; only: readonly string[] | null };
            // The stream's path only: its query holds the channels signed for this session.
            add({ kind: 'live', method: 'SSE', url: new URL(url, host.window.location.href).pathname, channel: hint.channel, hinted: hint.only });
          } catch {
            // Not a hint: nothing to show.
          }
        });
      }
    };
  }

  // A patch is shown (`patched`) as it is added — before its action reports the patches it applied (`patches`): either comes first.
  const snapshot = (id: number): PatchSnapshot => snapshots().find((item) => item.id === id) ?? keep(snapshots(), { id, at: Date.now(), state: 'shown' }, LIST_LIMIT);
  const settled = (ids: Iterable<number>, state: PatchSnapshot['state']) => {
    for (const id of ids) {
      const found = snapshots().find((item) => item.id === id);
      if (found?.state === 'shown') found.state = state;
    }
    changed();
  };

  return {
    get timeline() {
      return timeline();
    },
    get snapshots() {
      return snapshots();
    },
    get hydration() {
      return host.document(HYDRATION);
    },
    get left() {
      return host.left;
    },
    get cache() {
      return host.document(CACHE);
    },
    answerFor: (url) => {
      const answers = timeline().filter((entry) => entry.answered === url && entry.outcome === 'ok' && PAGE_KINDS.has(entry.kind));
      return answers.findLast((entry) => !entry.only && !entry.except && entry.kind !== 'deferred') ?? answers.at(-1);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    onStarted: (listener) => {
      if (host.started) {
        listener();
        return () => {};
      }
      let once = true;
      return host.on('started', () => {
        if (once) listener();
        once = false;
      });
    },
    stop: () => {
      stopped = true;
      listeners.clear();
      for (const items of [timeline(), snapshots(), host.document(HYDRATION)] as unknown[][]) items.length = 0;
      host.document(VISITS).clear();
      host.document(CACHE).clear();
    },
    record: {
      document: (url, requestId) => {
        // The document came first — before what its page loaded while it was rendered (islands).
        const items = timeline();
        const at = Math.min(Date.now(), items[0]?.at ?? Infinity);
        items.unshift({ id: ++next, kind: 'document', method: 'GET', url, at, end: at, status: documentStatus(), outcome: 'ok', answered: url, ...(requestId ? { requestId } : {}) });
        changed();
      },
      patches: (ids) => {
        if (host.left) return;
        for (const id of ids) {
          const found = snapshot(id);
          if (fresh) found.request = fresh.id;
        }
        if (fresh) fresh.patches = ids;
        else {
          // An action applies its patches before its request goes out: the next entry of this task takes them.
          waitingPatches = ids;
          queueMicrotask(() => void (waitingPatches = undefined));
        }
        changed();
      },
      patched: (id, beneath, changes) => {
        if (host.left) return;
        const found = snapshot(id);
        if (found.before) return;
        const keys = Object.keys(changes).filter((key) => changes[key] !== beneath[key]);
        found.before = Object.fromEntries(keys.map((key) => [key, beneath[key]]));
        found.after = Object.fromEntries(keys.map((key) => [key, changes[key]]));
        changed();
      },
      committed: (ids) => settled(ids, 'committed'),
      removed: (ids) => settled(ids, 'removed'),
      recoverable: (error, component, server) => {
        if (host.left) return;
        const { message, stack } = error instanceof Error ? error : { message: String(error), stack: undefined };
        keep(host.document(HYDRATION), { at: Date.now(), component, server, message, ...(stack ? { stack } : {}) }, LIST_LIMIT);
        changed();
      },
    },
  };
});

/**
 * The dev hook's reports, handed to the feature `api()` returns (the navigator's the bar attached to) — what the devtools' client
 * sets as `__MARMEON_DEVTOOLS_HOOK__`, with its own `navigator`. Reports before a navigator (a hydration error while the first
 * page hydrates) wait for it — at most a few.
 */
export function devtoolsReports(api: () => DevtoolsFeature | undefined): Omit<DevtoolsHook, 'navigator'> & { flush(): void } {
  const early: (() => void)[] = [];
  const report =
    <A extends unknown[]>(name: keyof DevtoolsFeature['record']) =>
    (...args: A) => {
      const target = api();
      const run = () => (api()?.record[name] as ((...args: A) => void) | undefined)?.(...args);
      if (target) run();
      else if (early.length < 20) early.push(run);
    };
  return {
    patches: report('patches'),
    patched: report('patched'),
    committed: report('committed'),
    removed: report('removed'),
    recoverable: report('recoverable'),
    flush: () => {
      for (const run of early.splice(0)) run();
    },
  };
}
