import { Logger, token } from '@marmeon/core';
import { editableResponse, RequestNonce, type CookieDefaults as CookieDefaultsOptions, type HttpContext, type MiddlewareClass, type Next } from '@marmeon/router';

/**
 * What every cookie of a request gets unless its `set` says otherwise — `@marmeon/session` binds it from its config
 * (`secure`: `SESSION_SECURE_COOKIE`, which follows `APP_URL`, E162), the kernel hands it to each request's cookie jar.
 */
export type CookieDefaults = CookieDefaultsOptions;
export const CookieDefaults = token<CookieDefaults>('CookieDefaults');

/** Stands for the response's nonce in a directive: `scriptSrc: [NONCE, "'strict-dynamic'"]` → `script-src 'nonce-…' 'strict-dynamic'`. */
export const NONCE: unique symbol = Symbol('nonce');

/** A source of a directive — `'self'`, `https://cdn.example`, `'strict-dynamic'` (quoted as in the header) — or {@link NONCE}. */
export type CspSource = string | typeof NONCE;

/**
 * The directives of a policy, camel-cased (`scriptSrc` → `script-src`). A list of sources, `true` for a directive without
 * sources (`upgradeInsecureRequests`), `false` to leave one of the defaults out.
 */
export interface CspDirectives {
  defaultSrc?: readonly CspSource[] | false;
  scriptSrc?: readonly CspSource[] | false;
  scriptSrcElem?: readonly CspSource[] | false;
  scriptSrcAttr?: readonly CspSource[] | false;
  styleSrc?: readonly CspSource[] | false;
  styleSrcElem?: readonly CspSource[] | false;
  styleSrcAttr?: readonly CspSource[] | false;
  imgSrc?: readonly CspSource[] | false;
  fontSrc?: readonly CspSource[] | false;
  connectSrc?: readonly CspSource[] | false;
  mediaSrc?: readonly CspSource[] | false;
  objectSrc?: readonly CspSource[] | false;
  frameSrc?: readonly CspSource[] | false;
  childSrc?: readonly CspSource[] | false;
  workerSrc?: readonly CspSource[] | false;
  manifestSrc?: readonly CspSource[] | false;
  baseUri?: readonly CspSource[] | false;
  formAction?: readonly CspSource[] | false;
  frameAncestors?: readonly CspSource[] | false;
  sandbox?: readonly string[] | true | false;
  reportUri?: readonly string[] | false;
  reportTo?: readonly string[] | false;
  requireTrustedTypesFor?: readonly string[] | false;
  trustedTypes?: readonly string[] | false;
  upgradeInsecureRequests?: boolean;
}

export interface ContentSecurityPolicyOptions extends CspDirectives {
  /** `Content-Security-Policy-Report-Only`: the browser reports what the policy would block (`reportUri`/`reportTo`), and blocks nothing. */
  reportOnly?: boolean;
}

/**
 * The strict default (E147): scripts only with the response's nonce — and what those load (`'strict-dynamic'`: the entry's
 * chunks, React's streamed scripts carry the nonce themselves) — no plugins, no `<base>` pointing elsewhere. Styles, images and
 * connections are not restricted: add those directives for your app.
 */
export const DEFAULT_CSP: Readonly<CspDirectives> = Object.freeze<CspDirectives>({
  scriptSrc: [NONCE, "'strict-dynamic'"],
  objectSrc: ["'none'"],
  baseUri: ["'self'"],
});

const HEADER = 'content-security-policy';
const REPORT_ONLY_HEADER = 'content-security-policy-report-only';

/** Where the nonce goes in the compiled header (sources cannot contain it). */
const SLOT = '\u0000';

/** The policy as header pieces: joined with the nonce per response — or one fixed string when it names none. */
export function compilePolicy(directives: CspDirectives): { pieces: readonly string[]; usesNonce: boolean } {
  const out: string[] = [];
  for (const [key, value] of Object.entries(directives) as [string, readonly CspSource[] | boolean | undefined][]) {
    if (value === undefined || value === false) continue;
    if (!/^[a-z][a-zA-Z]*$/.test(key)) throw new TypeError(`contentSecurityPolicy(): "${key}" is not a directive (camel-cased, like scriptSrc).`);
    const name = key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    if (value === true) {
      out.push(name);
      continue;
    }
    const sources = value.map((source) => {
      if (source === NONCE) return `'nonce-${SLOT}'`;
      if (typeof source !== 'string' || source === '' || /[;,\r\n]/.test(source) || source.includes(SLOT)) {
        throw new TypeError(`contentSecurityPolicy(): ${JSON.stringify(source)} in ${key} is not a source (no ";", "," or line breaks).`);
      }
      return source;
    });
    out.push(sources.length > 0 ? `${name} ${sources.join(' ')}` : name);
  }
  const pieces = out.join('; ').split(SLOT);
  return { pieces, usesNonce: pieces.length > 1 };
}

/**
 * A `Content-Security-Policy` for the documents the app renders (E147) — opt-in, with a strict default ({@link DEFAULT_CSP}):
 *
 * ```ts
 * middleware: { global: [SecurityHeaders, contentSecurityPolicy()] }                      // bootstrap/app.ts
 * contentSecurityPolicy({ imgSrc: ["'self'", 'data:'], frameAncestors: ["'none'"] })        // more directives
 * contentSecurityPolicy({ baseUri: false, reportOnly: true, reportUri: ['/csp-reports'] })   // a default left out, report only
 * ```
 *
 * Each response gets its own nonce (`ctx.nonce()`), made only when a document is rendered: the server puts it on the
 * template's tags (Vite's `html.cspNonce`, set by `marmeon()`), on React's streamed scripts and styles and on `<Head>`'s
 * scripts — and here into the header. Only HTML responses get the header, and only those without a policy of their own (the
 * devtools' pages, a sandboxed file): a JSON visit, an island or an API answer never needs a nonce.
 *
 * A page cached publicly (`Cache-Control: public`, `s-maxage`) with a nonce is logged once: a shared cache would hand the same
 * nonce to everybody, which a script injected into the page could reuse — keep such pages out of the policy or private.
 */
export function contentSecurityPolicy(options: ContentSecurityPolicyOptions = {}): MiddlewareClass<{}, {}> {
  const { reportOnly = false, ...given } = options;
  const { pieces, usesNonce } = compilePolicy({ ...DEFAULT_CSP, ...given });
  const fixed = pieces.join('');
  const header = reportOnly ? REPORT_ONLY_HEADER : HEADER;
  const warned = new Set<string>();

  const ContentSecurityPolicy = class {
    readonly #nonce: RequestNonce;
    readonly #logger: Logger;

    constructor(nonce: RequestNonce, logger: Logger) {
      this.#nonce = nonce;
      this.#logger = logger;
    }

    async handle(ctx: HttpContext, next: Next<{}>): Promise<Response> {
      // Documents rendered inside need the nonce; a response that turns out to be JSON never makes one.
      if (usesNonce) this.#nonce.want();
      const response = await next();
      if (!isDocument(response.headers.get('content-type')) || response.headers.has(HEADER) || response.headers.has(REPORT_ONLY_HEADER)) {
        return response;
      }
      if (usesNonce) this.#warnIfShared(ctx, response);
      const value = usesNonce ? pieces.join(this.#nonce.value) : fixed;
      // In place when the framework made the document for this request; a copy otherwise (one an app may hand out twice — the
      // nonce is this response's alone —, or with immutable headers).
      const secured = editableResponse(response);
      secured.headers.set(header, value);
      return secured;
    }

    #warnIfShared(ctx: HttpContext, response: Response): void {
      const cache = response.headers.get('cache-control')?.toLowerCase() ?? '';
      if (!/\bpublic\b|\bs-maxage\b/.test(cache)) return;
      const path = ctx.route?.path ?? new URL(ctx.request.url).pathname;
      if (warned.has(path) || warned.size > 100) return;
      warned.add(path);
      this.#logger.warn(
        `${path} is cached publicly (Cache-Control: ${cache}) and carries a CSP nonce: a shared cache hands the same nonce to everybody, ` +
          'and a script injected into the page could reuse it. Keep the page private (no cacheControl(\'public …\')) or leave it out of contentSecurityPolicy().',
        { path },
      );
    }
  };
  Object.defineProperty(ContentSecurityPolicy, 'name', { value: 'ContentSecurityPolicy' });
  return ContentSecurityPolicy;
}

/** A document a browser runs scripts in: HTML or XHTML — a media type is case-insensitive (`Text/HTML` is HTML too). */
function isDocument(contentType: string | null): boolean {
  const type = contentType?.split(';')[0]!.trim().toLowerCase();
  return type === 'text/html' || type === 'application/xhtml+xml';
}
