import { token } from '@bespokecore/core';
import { urlFor, type CheckRouteName, type Param, type Query, type RouteArgs, type RouteLookup, type RouteNameInput } from '@bespokecore/router';

const REDIRECT_RESULT = Symbol.for('bespokecore.redirect-result');

/**
 * Keeps data for the next request only — what `redirect().with()` needs — and hands out values
 * stored earlier (`redirect().intended()`). Bound by `@bespokecore/session` (to the request's
 * session), so http needs no session itself.
 */
export interface Flasher {
  flash(key: string, value: unknown): void;
  /** Returns a stored value and removes it. */
  pull(key: string): unknown;
}
export const Flasher = token<Flasher>('Flasher');

export type RedirectStatus = 301 | 302 | 303 | 307 | 308;

type Target =
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'route'; readonly name: string; readonly params?: Readonly<Record<string, Param>> | undefined; readonly query?: Query | undefined }
  | { readonly kind: 'back'; readonly fallback: string };

/**
 * What a controller returns to redirect — a description, like a view. The kernel
 * turns it into a response, because only it knows the router (named routes) and
 * the request (`back()`).
 *
 * ```ts
 * return this.redirect().route('user-profile.show', { user: user.id });
 * return this.back();
 * ```
 */
export class RedirectResult {
  readonly [REDIRECT_RESULT] = true;
  #target: Target | undefined;
  #intended = false;
  #status: RedirectStatus | undefined;
  readonly #headers = new Headers();
  readonly #flash = new Map<string, unknown>();

  constructor(url?: string, status?: RedirectStatus) {
    if (url !== undefined) this.#target = { kind: 'url', url };
    this.#status = status;
  }

  /**
   * Redirects to a named route: `route('user-profile.show', { user: 1 })`, with a query as the third argument.
   * Name and parameters are checked against the app's routes (`bootstrap/routes.ts`).
   */
  route<const N extends RouteNameInput>(name: CheckRouteName<N>, ...[params, query]: RouteArgs<N>): this {
    this.#target = { kind: 'route', name, params, query: query as Query | undefined };
    return this;
  }

  /** Redirects to the previous page (the `Referer` of this site), or to `fallback`. */
  back(fallback = '/'): this {
    this.#target = { kind: 'back', fallback };
    return this;
  }

  /**
   * To the page a guest asked for before being sent to log in (`authenticate()` stores it in the
   * session as {@link INTENDED_KEY}) — or, without one, to the target set otherwise:
   * `redirect().intended().route('dashboard')`. Only local paths are followed: never another site.
   */
  intended(): this {
    this.#intended = true;
    return this;
  }

  /**
   * Sets the status. By default, redirects answer GET requests with 302 and all
   * other methods with 303, so the browser follows up with a GET — a 302 after
   * PUT or DELETE would repeat the method.
   */
  status(status: RedirectStatus): this {
    this.#status = status;
    return this;
  }

  header(name: string, value: string): this {
    this.#headers.set(name, value);
    return this;
  }

  /** Flashes data to the session for the next request: `back().with('success', 'Saved.')`. */
  with(key: string, value: unknown): this;
  with(values: Record<string, unknown>): this;
  with(key: string | Record<string, unknown>, value?: unknown): this {
    for (const [name, data] of typeof key === 'string' ? [[key, value] as const] : Object.entries(key)) this.#flash.set(name, data);
    return this;
  }

  /** Flashes validation errors (`errors`) — what a failed page request shows next to the fields. */
  withErrors(errors: Record<string, readonly string[]>): this {
    return this.with(ERRORS_KEY, errors);
  }

  /**
   * Flashes the input for `old()`, so the form can be filled again. Files and
   * passwords never go into the session.
   */
  withInput(input: Record<string, unknown>): this {
    return this.with(OLD_INPUT_KEY, flashableInput(input));
  }

  toResponse(request: Request, routes: RouteLookup, flasher?: Flasher): Response {
    if (this.#flash.size > 0) {
      if (!flasher) throw new Error('redirect().with() needs a session: install @bespokecore/session and start it for this route.');
      for (const [key, value] of this.#flash) flasher.flash(key, value);
    }
    const intended = this.#intended ? flasher?.pull(INTENDED_KEY) : undefined;
    const headers = new Headers(this.#headers);
    headers.set('location', isLocalPath(intended) ? intended : this.#location(request, routes));
    const status = this.#status ?? (request.method === 'GET' || request.method === 'HEAD' ? 302 : 303);
    return new Response(null, { status, headers });
  }

  #location(request: Request, routes: RouteLookup): string {
    const target = this.#target;
    if (!target) throw new Error('redirect() needs a target: redirect(url), redirect().route(name) or back().');
    if (target.kind === 'url') return target.url;
    if (target.kind === 'route') return urlFor(routes, target.name, target.params, target.query);
    return previousUrl(request) ?? target.fallback;
  }
}

/** Session keys shared with @bespokecore/session (`old()`) and the shared `errors` prop. */
export const ERRORS_KEY = 'errors';
export const OLD_INPUT_KEY = '_old_input';
/** Where `authenticate()` keeps the page a guest wanted, for `redirect().intended()`. */
export const INTENDED_KEY = '_intended_url';

/**
 * Like Laravel's `$dontFlash`, but by pattern: no field with "password" in its name is ever kept in
 * the session (`password`, `password_confirmation`, `current_password`, `new_password`, …).
 */
const DONT_FLASH = /password/i;

/** A path on this site (`/users/1?tab=links`) — not `//evil.example`, `/\\evil.example` or a full URL. */
export function isLocalPath(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f]/.test(value)) return false;
  try {
    return new URL(value, 'http://local.invalid').host === 'local.invalid';
  } catch {
    return false;
  }
}

function flashableInput(input: Record<string, unknown>): Record<string, unknown> {
  const clean = (value: unknown): unknown => {
    if (typeof value === 'object' && value !== null && !(value instanceof File)) {
      if (Array.isArray(value)) return value.map(clean).filter((item) => item !== undefined);
      return flashableInput(value as Record<string, unknown>);
    }
    return value instanceof File ? undefined : value;
  };
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (DONT_FLASH.test(key) || key === '_token') continue;
    const cleaned = clean(value);
    if (cleaned !== undefined) result[key] = cleaned;
  }
  return result;
}

export function isRedirectResult(value: unknown): value is RedirectResult {
  return typeof value === 'object' && value !== null && REDIRECT_RESULT in value;
}

/**
 * The referring page — only from this host, and only as path and query, so
 * `back()` can never become an open redirect to another site.
 */
function previousUrl(request: Request): string | undefined {
  const referer = request.headers.get('referer');
  if (!referer) return undefined;
  try {
    const previous = new URL(referer);
    if (previous.host !== new URL(request.url).host) return undefined;
    return previous.pathname + previous.search;
  } catch {
    return undefined;
  }
}
