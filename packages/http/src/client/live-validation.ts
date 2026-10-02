/**
 * Live validation (E62), UI-free: a form's fields checked against the server's request schema while they are filled in —
 * Laravel's Precognition. The request is the form's own (same method, URL and body) plus `x-bespoke-validate: name,email`;
 * the server runs the route's middleware, `authorize` and schema — never its controller — and answers `204` or `422` with the
 * errors of the named fields only. Read-only on the server, never cached, held to its own rate limit.
 *
 * Only fields the user touched are named, so nobody sees "required" for a field they have not reached. Password fields
 * (`/password/i`) are never sent — not even in the body: a strength rule or a confirmation is checked when the form is sent.
 * Files neither (they go with the submit).
 */
import { ACTION_REDIRECT_HEADER, LOCATION_HEADER, VALIDATE_HEADER, VALIDATED_HEADER, type ValidationErrors } from '../page.ts';
import type { ActionException, ActionHost, ActionMethod } from './action.ts';

/** Field names live validation never sends: passwords, their confirmations, current passwords (`/password/i`). */
export const SENSITIVE_FIELD = /password/i;

/** Whether `field` (a name or a path: `account.password`) is never sent for live validation. */
export function isSensitiveField(field: string): boolean {
  return field.split('.').some((segment) => SENSITIVE_FIELD.test(segment));
}

/** What a live validation sends of a form's data: everything but password fields (at any depth) and files. */
export function liveValidationData(data: Record<string, unknown>): Record<string, unknown> {
  const strip = (value: unknown): unknown => {
    if (value instanceof Blob) return undefined;
    if (Array.isArray(value)) return value.map(strip).filter((item) => item !== undefined);
    if (typeof value === 'object' && value !== null && !(value instanceof Date)) {
      const result: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        if (SENSITIVE_FIELD.test(key)) continue;
        const kept = strip(item);
        if (kept !== undefined) result[key] = kept;
      }
      return result;
    }
    return value;
  };
  return strip(data) as Record<string, unknown>;
}

/** One live validation's request: the form's method and data, and the fields to check. */
export interface LiveValidationRequest {
  /** The form's method — a live validation of a GET (a filter form) does not exist. */
  readonly method: Exclude<ActionMethod, 'get'>;
  readonly data: Record<string, unknown>;
  /** The fields to check — password fields are left out. */
  readonly fields: readonly string[];
  readonly signal?: AbortSignal;
}

/**
 * How a live validation ended. `valid`/`invalid`: the server checked `fields` — `errors` has those that failed (all messages per
 * field). `exception`: no result — offline, a redirect of the route (a guest-only form after signing in elsewhere), 401/403/419,
 * 429 (checked too often: the submit still validates), 5xx. `cancelled`: a newer check, or the form was sent.
 */
export type LiveValidationOutcome =
  | { readonly kind: 'valid'; readonly fields: readonly string[] }
  | { readonly kind: 'invalid'; readonly fields: readonly string[]; readonly errors: ValidationErrors }
  | { readonly kind: 'exception'; readonly exception: ActionException }
  | { readonly kind: 'cancelled' };

const CANCELLED: LiveValidationOutcome = { kind: 'cancelled' };

/** Sends one live validation through the actions' host (fetch, XSRF, the document being left). */
export async function sendLiveValidation(host: ActionHost, url: string, { method, data, fields, signal }: LiveValidationRequest): Promise<LiveValidationOutcome> {
  const named = fields.filter((field) => !isSensitiveField(field));
  if (host.left || signal?.aborted || named.length === 0) return CANCELLED;
  const target = new URL(url, host.href);
  // The XSRF token and the form's data go to this site only.
  if (target.origin !== new URL(host.href).origin) throw new Error(`A live validation goes to this site, not to ${target.origin} (${url}).`);
  const request = host.request(target, method, liveValidationData(data));
  let response: Response;
  try {
    response = await host.fetch(request.url, {
      method: method.toUpperCase(),
      headers: { accept: 'application/json', ...request.headers, [VALIDATE_HEADER]: named.join(',') },
      body: request.body,
      ...(signal ? { signal } : {}),
      redirect: 'manual',
      cache: 'no-store',
      credentials: 'same-origin',
    });
  } catch (cause) {
    return signal?.aborted || host.left ? CANCELLED : { kind: 'exception', exception: { type: 'network', cause } };
  }
  if (signal?.aborted || host.left) {
    await response.body?.cancel();
    return CANCELLED;
  }
  const location = response.status === 409 ? response.headers.get(LOCATION_HEADER) : null;
  if (location) {
    // The document changed under it (signed out, a new build): loaded fully, nothing of this one stays.
    await response.body?.cancel();
    host.leaveFor(location);
    return CANCELLED;
  }
  const validated = response.headers.get(VALIDATED_HEADER);
  if (response.status === 204 && validated !== null) return { kind: 'valid', fields: named };
  if (response.status === 422 && validated !== null) {
    const body = (await response.json().catch(() => undefined)) as { errors?: unknown } | undefined;
    const errors = body && typeof body.errors === 'object' && body.errors !== null ? (body.errors as ValidationErrors) : {};
    // Only what was asked — whatever else a server says is not this check's to show.
    const asked = Object.fromEntries(Object.entries(errors).filter(([field, messages]) => named.some((name) => field === name || field.startsWith(`${name}.`)) && Array.isArray(messages)));
    return { kind: 'invalid', fields: named, errors: asked };
  }
  const redirected = response.headers.has(ACTION_REDIRECT_HEADER) || response.type === 'opaqueredirect';
  await response.body?.cancel();
  return { kind: 'exception', exception: { type: 'server', status: redirected ? 302 : response.status, message: undefined } };
}

/** When a form's fields are checked: when a field is left (`blur`, the default), or while typing, after a pause (`change`). */
export type LiveValidationTrigger = 'blur' | 'change';

export interface LiveValidationOptions {
  /** Sends one check — the navigator's `validate(url, …)` bound to the form's URL. */
  readonly send: (request: LiveValidationRequest) => Promise<LiveValidationOutcome>;
  readonly method: Exclude<ActionMethod, 'get'>;
  /** The form's data now. */
  readonly data: () => Record<string, unknown>;
  /** What a check found — for the adapter's errors: the checked fields' messages (`invalid`), or none of them failed (`valid`). */
  readonly onResult: (outcome: Extract<LiveValidationOutcome, { kind: 'valid' | 'invalid' }>) => void;
  /** Whether `field` shows an error now: then it is checked again while it is typed into (blur mode), so fixing it clears it. */
  readonly hasError?: (field: string) => boolean;
  readonly on?: LiveValidationTrigger;
  /** The pause after typing before a check (ms) — default 300. */
  readonly debounce?: number;
  /** The fields that may be checked — default every field (but passwords). */
  readonly fields?: readonly string[];
}

/** The default pause after typing before a live validation (ms). */
export const DEFAULT_LIVE_VALIDATION_DEBOUNCE = 300;

/**
 * The live validation of one form: which fields were touched, when to check, which check is under way (a newer one aborts it),
 * and which results are out of date (the field changed while it was checked). The adapter keeps the errors (form state is the
 * adapter's): it gets each result through `onResult` and asks `validating(field)` for the pending state.
 */
export class LiveValidation {
  readonly #options: LiveValidationOptions;
  readonly #touched = new Set<string>();
  /** A counter per field, raised when it changes — a result for an older value is not shown. */
  readonly #versions = new Map<string, number>();
  readonly #listeners = new Set<() => void>();
  #pending: readonly string[] = [];
  #running: AbortController | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #closed = false;

  constructor(options: LiveValidationOptions) {
    this.#options = options;
  }

  /** Whether `field` may be checked live: allowed by `fields`, and no password. */
  eligible(field: string): boolean {
    if (isSensitiveField(field)) return false;
    const allowed = this.#options.fields;
    return !allowed || allowed.some((name) => field === name || field.startsWith(`${name}.`));
  }

  /** The fields touched so far — what each check names. */
  get touched(): readonly string[] {
    return [...this.#touched];
  }

  /**
   * `field` changed (typed into, set): it counts as touched, a result for its old value is dropped — and it is checked after a
   * pause in `change` mode, or in `blur` mode when it shows an error now (so fixing it clears the message while typing).
   */
  changed(field: string): void {
    if (this.#closed || !this.eligible(field)) return;
    this.#touched.add(field);
    this.#versions.set(field, (this.#versions.get(field) ?? 0) + 1);
    if (this.#options.on === 'change' || this.#options.hasError?.(field)) this.#schedule(this.#options.debounce ?? DEFAULT_LIVE_VALIDATION_DEBOUNCE);
  }

  /** `field` was left: the touched fields are checked now — when it was touched (tabbing through an empty form asks nothing). */
  blurred(field: string): void {
    if (this.#closed || !this.#touched.has(field)) return;
    clearTimeout(this.#timer);
    void this.#run();
  }

  /** Checks the touched fields — and `fields`, which count as touched from now on — at once. */
  validate(...fields: string[]): Promise<LiveValidationOutcome> {
    for (const field of fields) if (this.eligible(field)) this.#touched.add(field);
    clearTimeout(this.#timer);
    return this.#run();
  }

  /** The fields of the check under way (a new array on each change — a snapshot for `useSyncExternalStore`). */
  get pending(): readonly string[] {
    return this.#pending;
  }

  /** Whether a check of `field` (or, without one, of any field) is under way. */
  validating(field?: string): boolean {
    if (field === undefined) return this.#pending.length > 0;
    return this.#pending.some((name) => name === field || name.startsWith(`${field}.`));
  }

  /** Stops what is scheduled or under way — the form is sent (its answer decides) or gone. */
  cancel(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#running?.abort();
    this.#running = undefined;
    this.#setPending([]);
  }

  /** After a successful submit: nothing is touched any more (the form starts over). */
  reset(): void {
    this.cancel();
    this.#touched.clear();
  }

  /** For good: the form unmounted. */
  close(): void {
    this.cancel();
    this.#closed = true;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  };

  #schedule(delay: number): void {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void this.#run(), delay);
  }

  async #run(): Promise<LiveValidationOutcome> {
    this.#timer = undefined;
    const fields = [...this.#touched];
    if (this.#closed || fields.length === 0) return CANCELLED;
    // A newer check of the same form replaces the one under way: it names the same fields (and more) with newer data.
    this.#running?.abort();
    const controller = new AbortController();
    this.#running = controller;
    const versions = new Map(fields.map((field) => [field, this.#versions.get(field) ?? 0]));
    this.#setPending(fields);
    let outcome: LiveValidationOutcome;
    try {
      outcome = await this.#options.send({ method: this.#options.method, data: this.#options.data(), fields, signal: controller.signal });
    } catch (error) {
      if (this.#running === controller) {
        this.#running = undefined;
        this.#setPending([]);
      }
      throw error;
    }
    if (this.#running !== controller || controller.signal.aborted || this.#closed) return CANCELLED;
    this.#running = undefined;
    this.#setPending([]);
    if (outcome.kind !== 'valid' && outcome.kind !== 'invalid') return outcome;
    // A field typed into while it was checked: its result is about an older value — not shown (the next check brings its own).
    const current = outcome.fields.filter((field) => versions.get(field) === (this.#versions.get(field) ?? 0));
    if (current.length === 0) return CANCELLED;
    const result =
      outcome.kind === 'valid'
        ? { kind: 'valid' as const, fields: current }
        : { kind: 'invalid' as const, fields: current, errors: Object.fromEntries(Object.entries(outcome.errors).filter(([field]) => current.some((name) => field === name || field.startsWith(`${name}.`)))) };
    this.#options.onResult(result);
    return result;
  }

  #setPending(fields: readonly string[]): void {
    if (fields.length === 0 && this.#pending.length === 0) return;
    this.#pending = fields;
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch (error) {
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  }
}
