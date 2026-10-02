/**
 * The events of the navigator's requests (E44, Inertia's names): `start`, `progress`, then `success`, `error`, `exception`
 * or `cancel`, and always `finish` — per visit (`onStart`, …) and for every request (`navigator.on`). Plus `flash` (E60) and
 * `version` (E64).
 */
import type { FlashMessage, PageObject, ValidationErrors } from '../page.ts';
import type { VisitMethod } from './navigation.ts';
import { call, notify } from './notify.ts';

/**
 * One request of the navigator: a visit, a reload, Back/Forward to a page that is not in memory — or, `async`, one
 * in the background (deferred props, a poll, `visit({ async: true })`): no progress bar, it neither cancels visits
 * nor is cancelled by them.
 */
export interface Visit {
  readonly url: string;
  readonly method: VisitMethod;
  readonly async?: boolean;
  /** The route's name, when the adapter gave it (`<Link route>`, `useForm(name)`) — what `usePending(name)` looks for. */
  readonly name?: string;
}

/** How far the upload of a `FormData` visit is. `total` and `percentage` are undefined when the size is unknown. */
export interface VisitProgress {
  readonly loaded: number;
  readonly total: number | undefined;
  readonly percentage: number | undefined;
}

/**
 * A visit that failed (E44: `exception`, as in Inertia) — the page stays as it is (nothing typed is lost) and the
 * app shows a fallback:
 * - `network`: the server could not be reached (offline, the server is down, the connection broke).
 * - `server`: the server answered with a 5xx — its error page (`page`, with the exception in debug mode) or, from
 *   something in front of it (a proxy), plain HTML (`html`).
 *
 * Validation errors are no failure: they are the `error` event (the page's `errors` prop, see `useForm`).
 */
export type VisitException =
  | { readonly type: 'network'; readonly visit: Visit; readonly cause: unknown }
  | { readonly type: 'server'; readonly visit: Visit; readonly status: number; readonly page: PageObject | undefined; readonly html: string | undefined };

/**
 * The events of a visit, in order: `start`, `progress` (uploads), then one of `success`, `error`, `exception` or
 * `cancel`, and always `finish` — Inertia's names and meanings (E44). Back/Forward to a page that is not in memory
 * and loading deferred props report `start`, `exception`/`cancel` and `finish` only (they are no visits of the
 * app's own); an `async` visit of the app (a poll) reports all of them. Prefetches report nothing.
 */
export interface VisitEvents {
  start: (visit: Visit) => void;
  progress: (progress: VisitProgress, visit: Visit) => void;
  /** The visit ended on a page without validation errors. */
  success: (page: PageObject, visit: Visit) => void;
  /** The visit ended on a page with validation errors (its `errors` prop — the server redirected back to the form). */
  error: (errors: ValidationErrors, visit: Visit) => void;
  /** The request failed: offline or a 5xx. The page stays; the app shows a fallback. */
  exception: (exception: VisitException) => void;
  /** A newer visit (or Back/Forward) replaced this one before it finished. */
  cancel: (visit: Visit) => void;
  finish: (visit: Visit) => void;
  /**
   * A flash message an answer delivered (E60) — once per message, whichever answer brought it (a page, a partial reload, a
   * layer, an action). A listener added later still gets those nobody heard yet (the first page's).
   */
  flash: (message: FlashMessage) => void;
  /**
   * A new build is out (E64): a request was answered `409` with `x-bespoke-reload: version`. By default the page loads fully —
   * after asking, when that would lose unsaved changes (a navigation guard). `event.preventDefault()` keeps the page as it is
   * ("a new version is available" instead); then the user's next visit loads fully, and `event.reload()` loads it now.
   * Signing in or out (the other 409) never fires it: that full load is never postponed.
   */
  version: (event: VersionChange) => void;
}

/** The `version` event (E64): a new build is out, and the page is about to load it fully. */
export interface VersionChange {
  /** Where the full load goes — the URL the request was for. */
  readonly location: string;
  /** Whether the full load would lose unsaved changes nobody agreed to leave (a navigation guard holds them). */
  readonly unsaved: boolean;
  /** Keeps the page: no full load now — the next visit of the user makes it (or {@link reload}). */
  preventDefault(): void;
  readonly defaultPrevented: boolean;
  /** Loads the new build now (a full load of `location`) — for a "new version available" banner's button. */
  reload(): void;
}

export type VisitEvent = keyof VisitEvents;

export interface VisitCallbacks {
  onStart?: VisitEvents['start'];
  onProgress?: VisitEvents['progress'];
  onSuccess?: VisitEvents['success'];
  onError?: VisitEvents['error'];
  onException?: VisitEvents['exception'];
  onCancel?: VisitEvents['cancel'];
  onFinish?: VisitEvents['finish'];
}

/** The events the navigator emits itself (flash messages go through their own channel). */
type EmittedEvent = Exclude<VisitEvent, 'flash'>;

/** The listeners of one navigator's events. */
export class VisitEmitter {
  readonly #listeners: { [E in EmittedEvent]: Set<VisitEvents[E]> } = {
    start: new Set(),
    progress: new Set(),
    success: new Set(),
    error: new Set(),
    exception: new Set(),
    cancel: new Set(),
    finish: new Set(),
    version: new Set(),
  };

  /** Listens to `event` of every request. Returns the function that stops listening. */
  on<E extends EmittedEvent>(event: E, listener: VisitEvents[E]): () => void {
    const listeners = this.#listeners[event] as Set<VisitEvents[E]>;
    listeners.add(listener);
    return () => void listeners.delete(listener);
  }

  /** The visit's own callback first, then every listener — a listener's bug breaks neither the navigation nor the others. */
  emit<E extends EmittedEvent>(event: E, callback: VisitEvents[E] | undefined, ...args: Parameters<VisitEvents[E]>): void {
    type Listener = (...args: Parameters<VisitEvents[E]>) => void;
    if (callback) call(callback as Listener, ...args);
    notify(this.#listeners[event] as Set<Listener>, ...args);
  }
}
