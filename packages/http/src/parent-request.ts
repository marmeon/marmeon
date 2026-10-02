import type { Container, Key } from '@bespokecore/core';

/**
 * The page request an island's request runs inside of — set by the kernel when it resolves an island in-process while
 * the page renders (E49); empty for every other request. Per request (scoped).
 *
 * Middleware that loads per-request state reads it from here instead of loading it again, as a copy — the island sees
 * the page request's state as it was when the island started (its session, with whoever the page signed in), and
 * nothing it does reaches the page (it is read-only anyway, E52). `StartSession` does this; anything else (cookies,
 * locale) works unchanged on the request the kernel builds: it carries the page request's cookies and headers.
 */
export class ParentRequest {
  #request: Request | undefined;
  #scope: Container | undefined;

  /** The page's request, or undefined outside an in-process island. */
  get request(): Request | undefined {
    return this.#request;
  }

  /**
   * What the page's request resolved of `token` (its session, say) — to copy from, never to change. Undefined outside an
   * in-process island.
   */
  resolve<T>(token: Key<T>): T | undefined {
    const scope = this.#scope;
    return scope?.has(token) ? (scope.make(token as never) as T) : undefined;
  }

  /** @internal — the kernel, for an island it resolves in-process. */
  adopt(request: Request, scope: Container): void {
    this.#request = request;
    this.#scope = scope;
  }
}
