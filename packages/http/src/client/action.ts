/**
 * Actions (E59), UI-free: requests that do not navigate — a like, removing a list item, a toggle. Typed by route name in the
 * adapter (`useAction`); here, by URL and method. An action never touches the history or the page cache: what it changes on
 * screen is an optimistic patch (rolled back when it fails) and the props it reloads when it succeeded.
 *
 * Security: an action is an ordinary request of its route — middleware, CSRF (`X-XSRF-TOKEN`), authorization and validation
 * run as for a form. Its answer is never cached (the server sends `no-store`, the request asks for none) and never followed
 * when it redirects. An action after signing out (401, 419) ends as an `exception`: shown, never retried by itself.
 */
import { ACTION_HEADER, ACTION_REDIRECT_HEADER, LOCATION_HEADER, type FlashMessage, type ValidationErrors } from '../page.ts';
import type { Confirm } from './confirm.ts';
import { flashOfResponse } from './flash.ts';
import { notify } from './notify.ts';
import { unite, type OptimisticUpdate, type PatchTarget, type Reloading, type ReloadSpec } from './optimistic.ts';
import { applyPatches, listOf, rollBack } from './patches.ts';

/** The methods of an action — a GET reads (its `data` goes into the query), the others write. */
export type ActionMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

/** Why an action failed besides invalid input: offline (`network`), or what the server answered (401, 403, 404, 419, 5xx, …). */
export type ActionException =
  | { readonly type: 'network'; readonly cause: unknown }
  | { readonly type: 'server'; readonly status: number; readonly message: string | undefined };

/**
 * How an action ended. `data`: the controller's JSON (`this.json(…)`); `redirect`: its controller redirected — reported, not
 * followed (`onRedirect: 'visit'` follows it); `invalid`: 422, the validation errors by field; `exception`: offline or a failure
 * status; `cancelled`: aborted (`cancel()`, a newer call with the same `key`, the document left).
 */
export type ActionOutcome =
  | { readonly ok: true; readonly kind: 'data'; readonly status: number; readonly data: unknown; readonly flash: readonly FlashMessage[] }
  | { readonly ok: true; readonly kind: 'redirect'; readonly redirect: string; readonly flash: readonly FlashMessage[] }
  | { readonly ok: false; readonly kind: 'invalid'; readonly errors: ValidationErrors; readonly message: string | undefined }
  | { readonly ok: false; readonly kind: 'exception'; readonly exception: ActionException }
  | { readonly ok: false; readonly kind: 'cancelled' };

export interface ActionOptions {
  /** Default `post`. */
  method?: ActionMethod;
  /** The body — JSON, or multipart when it is (or holds) a file. For a GET, the query string. */
  data?: Record<string, unknown> | FormData;
  headers?: Record<string, string>;
  /** The route's name: while under way, the action is listed in `navigator.submissions` by it (ghost rows, E59 model 2). */
  name?: string;
  /** What the listing shows of it — default `data`. */
  input?: unknown;
  /** A newer action with the same key cancels this one (a toggle clicked twice: the last click counts). Without one, actions run side by side. */
  key?: string;
  /** Aborts the action (it ends `cancelled`, its patches rolled back). */
  signal?: AbortSignal;
  /** Patches shown at once (model 1): rolled back unless it succeeds; reconciled with `reload` when it does. */
  optimistic?: OptimisticUpdate | readonly OptimisticUpdate[];
  /**
   * After it succeeded: reload these — some props of the page or a layer, an island — in the background. A patch on a target
   * that reloads goes in the same update the server's props land in; a patch on any other target becomes its state.
   */
  reload?: Reloading | readonly Reloading[];
  /** `'visit'`: when its controller redirected, go there (a visit) after it ended. Default: report it only. */
  onRedirect?: 'visit';
  /** Ask first (E64) — a no sends nothing: the action ends `cancelled`, nothing optimistic shows. */
  confirm?: Confirm;
}

/** An action (or a form's visit) under way, as `navigator.submissions` lists it — what ghost rows are made of (E59 model 2). */
export interface Submission {
  readonly id: number;
  /** The route's name, when the adapter gave it. */
  readonly name: string | undefined;
  readonly method: ActionMethod;
  readonly url: string;
  /** What it sends (its `data`, or `input`). */
  readonly input: unknown;
}

/** What actions need of the navigator. */
export interface ActionHost {
  /** The document is being left (signed out, a new build): nothing lands any more. */
  readonly left: boolean;
  readonly href: string;
  fetch(url: string, init: RequestInit): Promise<Response>;
  /** A 409 with a location (signed out through the action): load it fully — memory goes with the document. */
  leaveFor(location: string): void;
  /** A write succeeded: pages fetched ahead are out of date. */
  changed(): void;
  visit(url: string): Promise<unknown>;
  /** The request of an action: URL, headers (XSRF for a write) and body. */
  request(target: URL, method: ActionMethod, data: ActionOptions['data']): { url: string; headers: Record<string, string>; body?: BodyInit };
  /** Asks the user (E64): whether to send it. */
  confirm(confirm: Confirm): Promise<boolean>;
  /** The flash messages its answer delivered (E60): they fire, once each. */
  flash(messages: readonly FlashMessage[]): void;
}

/** The submissions under way — actions, and the visits of route forms — with listeners (for `useSyncExternalStore`). */
export class Submissions {
  #list: readonly Submission[] = [];
  #next = 0;
  readonly #listeners = new Set<() => void>();

  get list(): readonly Submission[] {
    return this.#list;
  }

  /** Lists one; returns the function that takes it out. */
  add(entry: Omit<Submission, 'id'>): () => void {
    const submission: Submission = { id: ++this.#next, ...entry };
    this.#list = [...this.#list, submission];
    this.#emit();
    return () => {
      if (!this.#list.includes(submission)) return;
      this.#list = this.#list.filter((item) => item !== submission);
      this.#emit();
    };
  }

  clear(): void {
    if (this.#list.length === 0) return;
    this.#list = [];
    this.#emit();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  };

  #emit(): void {
    notify(this.#listeners);
  }
}

/**
 * The patches of an action that succeeded: on a target it reloads, they go once the reload landed; on any other, they become
 * its state at once. Resolves once every reload is settled.
 */
export async function reconcile(applied: ReadonlyMap<PatchTarget, readonly number[]>, reloads: readonly Reloading[]): Promise<void> {
  const reloaded = new Set(reloads.map((reload) => reload.target));
  for (const [target, ids] of applied) if (!reloaded.has(target)) target.settle(ids, true);
  // One reload per target: what several reloads of it asked for, together.
  const byTarget = new Map<PatchTarget, Reloading['spec'][]>();
  for (const { target, spec } of reloads) byTarget.set(target, [...(byTarget.get(target) ?? []), spec]);
  await Promise.all(
    [...byTarget].map(([target, specs]) => {
      const spec = specs.reduce<ReloadSpec | undefined>((united, one) => unite(united, one), undefined) ?? {};
      return target.revalidate(spec, applied.get(target) ?? []);
    }),
  );
}

const CANCELLED: ActionOutcome = { ok: false, kind: 'cancelled' };

/** The actions of one navigator. */
export class Actions {
  readonly #host: ActionHost;
  readonly #submissions: Submissions;
  /** Actions under way by key — a newer one with the same key aborts the older. */
  readonly #keyed = new Map<string, AbortController>();
  /** Every action under way (aborted when the document is left). */
  readonly #running = new Set<AbortController>();

  constructor(host: ActionHost, submissions: Submissions) {
    this.#host = host;
    this.#submissions = submissions;
  }

  /** Aborts every action under way — the document is left. */
  abortAll(): void {
    for (const controller of this.#running) controller.abort();
  }

  async run(url: string, options: ActionOptions = {}): Promise<ActionOutcome> {
    const { method = 'post', data, headers = {}, name, key, signal, onRedirect } = options;
    if (this.#host.left || signal?.aborted) return CANCELLED;
    const target = new URL(url, this.#host.href);
    // The XSRF token goes with a write: never to another site.
    if (target.origin !== new URL(this.#host.href).origin) throw new Error(`An action goes to this site, not to ${target.origin} (${url}).`);
    // Asked first (E64): a no sends nothing — no request, no patch, no listing.
    if (options.confirm !== undefined && !(await this.#host.confirm(options.confirm))) return CANCELLED;
    if (this.#host.left || signal?.aborted) return CANCELLED;

    const controller = new AbortController();
    if (key !== undefined) {
      this.#keyed.get(key)?.abort();
      this.#keyed.set(key, controller);
    }
    this.#running.add(controller);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const request = this.#host.request(target, method, data);
    const untrack = this.#submissions.add({ name, method, url: request.url, input: options.input ?? data });
    // Model 1: shown at once.
    const applied = applyPatches(listOf(options.optimistic));
    let outcome: ActionOutcome = CANCELLED;
    try {
      outcome = await this.#send(request, method, headers, controller.signal);
      if (controller.signal.aborted || this.#host.left) outcome = CANCELLED;
      if (!outcome.ok) {
        rollBack(applied);
        return outcome;
      }
      if (method !== 'get') this.#host.changed();
      // Its patches reconciled with the server's props — the submission stays listed until they are (no gap for a ghost row).
      await reconcile(applied, listOf(options.reload));
      // Its flash messages (E60) — delivered with its answer, fired once what it reloads is on screen.
      if (!this.#host.left) this.#host.flash(outcome.flash);
      if (outcome.kind === 'redirect' && onRedirect === 'visit' && !this.#host.left) await this.#host.visit(outcome.redirect);
      return outcome;
    } catch (error) {
      // A bug of a patch or reload — the action itself ended; nothing it patched stays.
      rollBack(applied);
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
      this.#running.delete(controller);
      if (key !== undefined && this.#keyed.get(key) === controller) this.#keyed.delete(key);
      untrack();
    }
  }

  async #send(request: { url: string; headers: Record<string, string>; body?: BodyInit }, method: ActionMethod, headers: Record<string, string>, signal: AbortSignal): Promise<ActionOutcome> {
    let response: Response;
    try {
      response = await this.#host.fetch(request.url, {
        method: method.toUpperCase(),
        headers: { accept: 'application/json', [ACTION_HEADER]: 'true', ...request.headers, ...headers },
        body: request.body,
        signal,
        // Never followed: the server reports where a redirect points (204 + x-marmeon-redirect).
        redirect: 'manual',
        // Never from, never into, the HTTP cache — the answer is about who asks, now.
        cache: 'no-store',
        credentials: 'same-origin',
      });
    } catch (cause) {
      return signal.aborted || this.#host.left ? CANCELLED : { ok: false, kind: 'exception', exception: { type: 'network', cause } };
    }
    if (signal.aborted || this.#host.left) {
      await response.body?.cancel();
      return CANCELLED;
    }
    const location = response.status === 409 ? response.headers.get(LOCATION_HEADER) : null;
    if (location) {
      // Signed out (or in) through the action, a new build: the document changes — nothing of this one stays in memory.
      await response.body?.cancel();
      this.#host.leaveFor(location);
      return CANCELLED;
    }
    // The flash messages it took (E60): with the outcome — and, for a failure, fired as they are.
    const flash = flashOfResponse(response);
    if (!response.ok && response.status !== 204) this.#host.flash(flash);
    const redirect = response.headers.get(ACTION_REDIRECT_HEADER);
    if (redirect !== null) {
      await response.body?.cancel();
      return { ok: true, kind: 'redirect', redirect, flash };
    }
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      // A redirect the server did not turn (a proxy in front of it): never followed, and where it points is unknown.
      return { ok: false, kind: 'exception', exception: { type: 'server', status: response.status || 302, message: undefined } };
    }
    const body = await readJson(response);
    if (response.status === 422 && isErrors(body)) {
      return { ok: false, kind: 'invalid', errors: body.errors, message: typeof body.message === 'string' ? body.message : undefined };
    }
    if (!response.ok) {
      const message = typeof body === 'object' && body !== null && typeof (body as { message?: unknown }).message === 'string' ? (body as { message: string }).message : undefined;
      return { ok: false, kind: 'exception', exception: { type: 'server', status: response.status, message } };
    }
    return { ok: true, kind: 'data', status: response.status, data: body, flash };
  }
}

async function readJson(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('json')) {
    await response.body?.cancel();
    return undefined;
  }
  try {
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  }
}

function isErrors(body: unknown): body is { errors: ValidationErrors; message?: unknown } {
  if (typeof body !== 'object' || body === null) return false;
  const errors = (body as { errors?: unknown }).errors;
  return typeof errors === 'object' && errors !== null && Object.values(errors).every((messages) => Array.isArray(messages));
}
