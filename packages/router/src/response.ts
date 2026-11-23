/**
 * Responses whose headers this request may change in place — the framework made them for this request (a page, a document, a
 * redirect, a region, an error page) or copied them once already. Weak: a response that is gone is forgotten.
 */
const owned = new WeakSet<Response>();

/**
 * Marks `response` as made for this request alone: middleware may set its headers in place ({@link editableResponse}). Only for a
 * response just constructed with mutable headers — never one an app could hand out twice (a module-level constant), one from
 * `fetch()` or `Response.redirect()`.
 */
export function ownResponse<R extends Response>(response: R): R {
  owned.add(response);
  return response;
}

/** The platform's own `Response`: what `Response` is when no adapter has put a class of its own in front of it. */
const platformResponse = (() => {
  let platform: { prototype: object } = Response;
  // Up to the class whose parent is no class: the parent of the root is a realm's `Function.prototype`, which has no `prototype`.
  for (let parent = Object.getPrototypeOf(platform) as { prototype?: unknown } | null; typeof parent?.prototype === 'object' && parent.prototype !== null; parent = Object.getPrototypeOf(platform)) {
    platform = parent as { prototype: object };
  }
  return platform;
})();

/**
 * Whether `value` is a `Response` that a route may return: one that is not from `fetch()`, also a subclass or a clone of one. Throws a
 * `TypeError` for one it must not pass on: from `fetch()` or its clone, `Response.error()`, and one whose body is used or locked.
 * `false` means `value` is no `Response` of the platform at all. Never `instanceof`: Node's adapter makes that true for every
 * platform `Response`.
 * @internal
 */
export function isResponse(value: unknown): value is Response {
  if (!platformResponse.prototype.isPrototypeOf(value as object)) return false;
  const response = value as Response;
  if (response.type !== 'default' || response.bodyUsed || response.body?.locked) {
    throw new TypeError("A route returned a Response it must not pass on: one from fetch(), Response.error(), or one whose body is used or locked. Build a Response of your own from the body and the headers you mean to pass on.");
  }
  return true;
}

/**
 * `response`, ready for its headers to be set: itself when this request owns it ({@link ownResponse}), else a copy it owns from
 * now on — at most one copy per request. A response the framework did not make is copied rather than changed: an app may return
 * the same `Response` twice, and a cookie set in place would reach the next request that gets it; its headers may also be
 * immutable (`Response.redirect`, `fetch`). See docs/middleware.md#changing-the-response.
 */
export function editableResponse(response: Response): Response {
  if (owned.has(response)) return response;
  const copy = new Response(response.body, response);
  owned.add(copy);
  return copy;
}

/**
 * The `Content-Disposition` value that names a download, safe for any filename: an ASCII fallback in which quotes, backslashes,
 * slashes, percent signs, control characters (CR and LF cannot break the header) and non-ASCII characters become `_`, plus the
 * real name as `filename*` (RFC 8187; a lone surrogate becomes U+FFFD). `serveFile()` uses the same encoder. See docs/responses.md#downloads.
 */
export function contentDisposition(type: 'attachment' | 'inline', filename: string): string {
  // encodeURIComponent throws on a lone surrogate (a slice() through an emoji).
  filename = filename.toWellFormed();
  const fallback = filename.replace(/[^\x20-\x7e]|["\\/%]/g, '_');
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}
