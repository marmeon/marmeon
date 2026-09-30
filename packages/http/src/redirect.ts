const REDIRECT_RESULT = Symbol.for('bespokecore.redirect-result');

export type RedirectStatus = 301 | 302 | 303 | 307 | 308;

/** Builds URLs for named routes — the router. */
export interface UrlGenerator {
  url(name: string, params?: Record<string, string | number>): string;
}

type Target =
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'route'; readonly name: string; readonly params: Record<string, string | number> }
  | { readonly kind: 'back'; readonly fallback: string };

/**
 * What a controller returns to redirect — a description, like a view. The kernel
 * turns it into a response, because only it knows the router (named routes) and
 * the request (`back()`).
 *
 * ```ts
 * return this.redirect().route('user-profile.show', { id: user.id });
 * return this.back();
 * ```
 */
export class RedirectResult {
  readonly [REDIRECT_RESULT] = true;
  #target: Target | undefined;
  #status: RedirectStatus | undefined;
  readonly #headers = new Headers();

  constructor(url?: string, status?: RedirectStatus) {
    if (url !== undefined) this.#target = { kind: 'url', url };
    this.#status = status;
  }

  /** Redirects to a named route: `route('user-profile.show', { id: 1 })`. */
  route(name: string, params: Record<string, string | number> = {}): this {
    this.#target = { kind: 'route', name, params };
    return this;
  }

  /** Redirects to the previous page (the `Referer` of this site), or to `fallback`. */
  back(fallback = '/'): this {
    this.#target = { kind: 'back', fallback };
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

  toResponse(request: Request, urls: UrlGenerator): Response {
    const headers = new Headers(this.#headers);
    headers.set('location', this.#location(request, urls));
    const status = this.#status ?? (request.method === 'GET' || request.method === 'HEAD' ? 302 : 303);
    return new Response(null, { status, headers });
  }

  #location(request: Request, urls: UrlGenerator): string {
    const target = this.#target;
    if (!target) throw new Error('redirect() needs a target: redirect(url), redirect().route(name) or back().');
    if (target.kind === 'url') return target.url;
    if (target.kind === 'route') return urls.url(target.name, target.params);
    return previousUrl(request) ?? target.fallback;
  }
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
