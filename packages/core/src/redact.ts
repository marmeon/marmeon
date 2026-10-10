/** Keys whose values never reach a log (or a stored error): passwords, tokens, secrets, credentials and cookies. */
export const REDACTED_KEYS = /pass(word)?|secret|token|authorization|cookie|remember|api[-_]?key|signature/i;

/**
 * A log entry's context with sensitive values replaced by `[redacted]`, by the core's key list alone — what
 * {@link Redactor.log} does for a logger without an app. A logger of an app redacts with the app's `Redactor`, so the names
 * the app's packages add count too.
 */
export function redact(context: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return new Redactor().log(context);
}

/** How deep {@link Redactor.log} follows a log context; deeper values are written as `[…]`. */
const MAX_DEPTH = 6;
/** How many causes an error's message and stack name at most. */
const MAX_CAUSES = 5;

// `password=…`, `token: …`, `"api_key":"…"`, `?signature=…&` — a sensitive key followed by its value (not a statement's `?`/`$1`
// placeholder: `where password = ?` stays readable). Matches start at a word's beginning only (the lookbehind): otherwise a
// long word costs quadratic time (a 64 KB string took seconds).
const KEY_VALUE = /(?<![\w-])([\w-]*(?:pass(?:word)?|secret|token|authorization|cookie|remember|api[-_]?key|signature)[\w-]*)("?\s*[:=]\s*"?)(?!\[redacted\]|\?|\$\d)((?:Bearer|Basic)\s+)?([^\s"'&,;}]+)/gi;
// `Authorization: Bearer …` without the key in front (a header value on its own).
const BEARER = /\b(Bearer|Basic)\s+(?!\[redacted\])[\w.~+/=-]+/g;
// `postgres://user:secret@host`, `redis://:secret@host` — the password of a URL.
const URL_PASSWORD = /(?<![\w+.-])([a-z][\w+.-]*:\/\/[^:\s/@]*:)[^@\s/]+@/gi;
// A password hash as a PHC string — `$argon2id$v=19$m=…$salt$hash`, `$scrypt$…`: never shown, wherever it appears.
const PHC_HASH = /\$(?:argon2(?:id|i|d)|scrypt|pbkdf2(?:-sha\d+)?|bcrypt|2[abxy])\$[\w+/=,.$-]*[\w+/=$-]/g;
// An API token (`marmeon_12|<secret>`) under any prefix: its id stays, the secret goes.
const API_TOKEN = /\b([a-z0-9_]{0,16}?\d+)\|[A-Za-z0-9]{32,}/g;
// A path segment of 32 or more URL-safe characters (`/reset-password/<token>`, a signed link's hash) — kept unless it reads
// like a word or an id (see `looksLikeToken`). Matches start right after a `/` only (no quadratic scan of long words).
const PATH_SEGMENT = /(?<=\/)[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// What every pattern above (and an added name's `name=value`) needs to match at all: a separator (`:` `=`), a `$` (PHC),
// whitespace (`Bearer …`) or a run of 32 URL-safe characters (a token-like segment — and an API token's secret). A text
// without any of them — a request path like `/users/7/edit`, on every request's log line — has nothing to mask: one test
// instead of seven replaces.
const MAYBE_SECRET = /[:=$\s]|[\w-]{32}/;

/** From this length on, upper- and lower-case letters alone make a segment a token (see `looksLikeToken`). */
const LONG_SEGMENT = 40;

/**
 * Whether a long path segment is a secret rather than a name: a hex string (a hash) or a random-looking base64url string. Slugs
 * (`my-long-article-title-2026`, lower case) and UUIDs (ids) stay. From {@link LONG_SEGMENT} characters on — a reset or e-mail
 * change token is 43 (32 random bytes) — upper- and lower-case letters are enough: random base64url has no digit in about 1 of
 * 1,500 tokens and more `-`/`_` than one in eight in about 1 of 480 — the test for shorter segments, which also needs a digit
 * and few separators, would leave those in a log.
 */
function looksLikeToken(segment: string): boolean {
  if (UUID.test(segment)) return false;
  if (/^[0-9a-f]+$/i.test(segment)) return true;
  const mixedCase = /[a-z]/.test(segment) && /[A-Z]/.test(segment);
  if (segment.length >= LONG_SEGMENT) return mixedCase;
  const separators = segment.length - segment.replaceAll(/[-_]/g, '').length;
  return mixedCase && /\d/.test(segment) && separators * 8 <= segment.length;
}

/**
 * Text — an error's message and stack, as stored for a failed job — with what looks like a secret replaced: values of
 * sensitive keys (`password=…`, `"token":"…"`, `?signature=…`), bearer credentials, passwords in URLs, password hashes
 * (PHC strings), API tokens and token-like path segments (`/reset-password/<token>` in a link, a log line or a `Referer`).
 * A safety net, not a guarantee: an error that quotes a secret in free text still shows it.
 */
export function redactText(text: string): string {
  return text
    .replace(URL_PASSWORD, '$1***@')
    .replace(PHC_HASH, '[redacted]')
    .replace(API_TOKEN, '$1|[redacted]')
    .replace(PATH_SEGMENT, (segment) => (looksLikeToken(segment) ? '[redacted]' : segment))
    .replace(KEY_VALUE, (_, key: string, separator: string, scheme: string | undefined) => `${key}${separator}${scheme ?? ''}[redacted]`)
    .replace(BEARER, '$1 [redacted]');
}

/** What replaces a redacted value. */
export const REDACTED = '[redacted]';

/** What an encrypted payload (a job with `static encrypted`, a queued mail or listener) is shown as — never its contents. */
export const ENCRYPTED = '[encrypted]';

/** The most of one value (a string, a statement, a body) that is shown or recorded — the rest is cut off. */
export const MAX_ENTRY_BYTES = 64 * 1024;

/** A statement as the `db.query` channel publishes it (`DbQueryMessage`). */
export interface RedactableQuery {
  readonly sql: string;
  readonly parameters: readonly unknown[];
  /** The statement touches a table with secret columns: none of its parameters is shown. */
  readonly secret: boolean;
}

/**
 * The one place that decides what of a value may be shown or recorded — for the development error page and its
 * Markdown copy, the devtools recorder and telemetry spans alike, also locally:
 *
 * - **by key**, at any depth: {@link REDACTED_KEYS} (passwords, tokens, secrets, cookies, `authorization`, signatures — so also
 *   `set-cookie`, `x-xsrf-token`, `_token`) and the names packages add — the session's cookie (`addKeys`);
 * - **in text**: what {@link redactText} masks (values of sensitive keys, bearer credentials, URL passwords, password hashes,
 *   API tokens) and the values of the added names (`marmeon_session=…`);
 * - **statements** that touch a table with secret columns show none of their parameters;
 * - **files and bytes** are never shown, only their size; every string is cut at {@link MAX_ENTRY_BYTES}.
 *
 * One per app (`app.container.make(Redactor)`), so the names an app adds stay its own.
 */
export class Redactor {
  readonly #keys = new Set<string>();
  #text: RegExp | undefined;

  constructor(keys: Iterable<string> = []) {
    this.addKeys(...keys);
  }

  /** More names whose values are never shown — a cookie's name (`marmeon_session`), a header, a field. Case does not matter. */
  addKeys(...keys: string[]): this {
    for (const key of keys) if (key !== '') this.#keys.add(key.toLowerCase());
    const names = [...this.#keys].map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    this.#text = names.length > 0 ? new RegExp(`(\\b(?:${names.join('|')}))(\\s*[:=]\\s*"?)(?!\\[redacted\\])([^\\s"'&,;}]+)`, 'gi') : undefined;
    return this;
  }

  /** Whether the value under `key` is never shown. */
  isSensitive(key: string): boolean {
    return REDACTED_KEYS.test(key) || this.#keys.has(key.toLowerCase());
  }

  /**
   * A log entry's context that may be written — the log path, plain data for any logger:
   *
   * - **by key**, at any depth: the values of sensitive keys ({@link isSensitive}: the core's list and the added names) replaced,
   *   also inside lists, maps and sets; deeper than six levels, a value is written as `[…]`;
   * - **errors under any key** as `{ type, message, stack, …own fields }` — the message and stack name the causes
   *   (`: cause`, `caused by: …`), are masked as text ({@link text}) and their own fields are redacted by key; an aggregate
   *   error's errors go to `aggregateErrors`;
   * - **URLs** as masked text; dates, buffers and other strings as they are (only keys are checked in a context).
   */
  log(context: Readonly<Record<string, unknown>>): Record<string, unknown> {
    return this.#logObject(context, 0);
  }

  #logObject(context: Readonly<Record<string, unknown>>, depth: number): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(context)) out[key] = this.isSensitive(key) ? REDACTED : this.#logValue(value, depth);
    return out;
  }

  /** A value inside a log context (`depth`: the level of the object holding it). */
  #logValue(value: unknown, depth: number): unknown {
    if (value === null || typeof value !== 'object') return value;
    if (depth >= MAX_DEPTH) return '[…]';
    if (value instanceof Error) return this.#logError(value, depth + 1, new Set());
    if (Array.isArray(value) || value instanceof Set) return [...(value as Iterable<unknown>)].map((item) => this.#logValue(item, depth + 1));
    if (value instanceof Map) return this.#logObject(Object.fromEntries(value), depth + 1);
    // A URL is text with a query (`?token=…`) and a path (`/reset-password/<token>`): masked like text, never written as it is.
    if (value instanceof URL || value instanceof URLSearchParams) return this.text(String(value));
    // Dates, buffers and typed arrays: written as they are (their `toJSON`, or bytes).
    if (typeof (value as { toJSON?: unknown }).toJSON === 'function' || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
    return this.#logObject(value as Record<string, unknown>, depth + 1);
  }

  /** An error as a logger writes it: its type, message and stack with the causes', masked; its own fields redacted by key. */
  #logError(error: Error, depth: number, seen: Set<Error>): Record<string, unknown> {
    seen.add(error);
    const causes: Error[] = [];
    for (let cause = error.cause; cause instanceof Error && !causes.includes(cause) && cause !== error && causes.length < MAX_CAUSES; cause = cause.cause) causes.push(cause);
    const constructor = (error as { constructor?: unknown }).constructor;
    const out: Record<string, unknown> = {
      type: typeof constructor === 'function' && constructor.name !== '' ? constructor.name : error.name,
      // Each one masked on its own: a value is masked up to the next space, which would take the `: ` joining them along.
      message: [error, ...causes].map((item) => this.text(String(item.message))).join(': '),
      stack: [error, ...causes].map((item) => this.text(item.stack ?? `${item.name}: ${item.message}`)).join('\ncaused by: '),
    };
    const nested = (value: unknown): unknown =>
      value instanceof Error ? (seen.has(value) || depth >= MAX_DEPTH ? '[…]' : this.#logError(value, depth + 1, seen)) : this.#logValue(value, depth);
    const errors = (error as { errors?: unknown }).errors;
    if (Array.isArray(errors)) out.aggregateErrors = errors.map(nested);
    // A cause that is no error is not in the message: written as a field.
    if (error.cause !== undefined && !(error.cause instanceof Error)) out.cause = this.isSensitive('cause') ? REDACTED : nested(error.cause);
    for (const [key, value] of Object.entries(error)) {
      if (key in out || key === 'cause') continue;
      out[key] = this.isSensitive(key) ? REDACTED : nested(value);
    }
    return out;
  }

  /** `text` without what looks like a secret ({@link redactText} and the added names' values), cut at {@link MAX_ENTRY_BYTES}. */
  text(text: string): string {
    if (text.length <= MAX_ENTRY_BYTES && !MAYBE_SECRET.test(text)) return text;
    const masked = redactText(text);
    return truncate(this.#text ? masked.replace(this.#text, `$1$2${REDACTED}`) : masked);
  }

  /**
   * A copy of `value` that may be shown: sensitive keys' values replaced at any depth, strings masked ({@link text}), files
   * and bytes as their size only, errors as name, message and stack. Plain data comes out — safe for `JSON.stringify`.
   */
  value(value: unknown, depth = 0): unknown {
    if (typeof value === 'string') return this.text(value);
    if (value === null || typeof value !== 'object') return typeof value === 'bigint' || typeof value === 'symbol' || typeof value === 'function' ? String(value) : value;
    if (depth >= 8) return '[…]';
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
    if (value instanceof URL) return this.url(value.href);
    if (value instanceof URLSearchParams) return this.text(value.toString());
    if (typeof Blob !== 'undefined' && value instanceof Blob) {
      const name = (value as { name?: unknown }).name;
      return `[${typeof name === 'string' ? `file ${this.text(name)}, ` : ''}${value.size} bytes${value.type ? `, ${value.type}` : ''}]`;
    }
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return `[${value.byteLength} bytes]`;
    if (value instanceof Error) return { name: value.name, message: this.text(value.message), ...(value.stack ? { stack: this.text(value.stack) } : {}) };
    if (value instanceof Map) return this.value(Object.fromEntries(value), depth);
    if (value instanceof Set || Array.isArray(value)) return [...(value as Iterable<unknown>)].slice(0, 1000).map((item) => this.value(item, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = this.isSensitive(key) ? REDACTED : this.value(entry, depth + 1);
    return out;
  }

  /**
   * Headers that may be shown: the values of sensitive ones (`cookie`, `authorization`, `set-cookie`, `x-xsrf-token`) replaced.
   * A header given more than once (Node's `IncomingHttpHeaders`: `set-cookie` as a list) is shown as one, its values joined.
   */
  headers(
    headers: Headers | Iterable<readonly [string, string]> | Readonly<Record<string, string | readonly string[] | undefined>>,
  ): Record<string, string> {
    const entries = headers instanceof Headers || Symbol.iterator in headers ? [...(headers as Iterable<readonly [string, string]>)] : Object.entries(headers);
    const out: Record<string, string> = {};
    for (const [name, value] of entries) {
      if (value === undefined) continue;
      out[name] = this.isSensitive(name) ? REDACTED : this.text(typeof value === 'string' ? value : value.join(', '));
    }
    return out;
  }

  /** A statement that may be shown: with `secret`, no parameter at all; otherwise each one masked like any value. */
  query(query: RedactableQuery): { sql: string; parameters: unknown[] } {
    return {
      sql: this.text(query.sql),
      parameters: query.secret ? query.parameters.map(() => REDACTED) : query.parameters.map((parameter) => this.value(parameter)),
    };
  }

  /**
   * A queued payload that may be shown: an encrypted one (a job with `static encrypted`, a queued mail or listener — it may
   * carry tokens or signed links) only as {@link ENCRYPTED}, never its contents; any other masked like a value.
   */
  payload(payload: unknown, encrypted: boolean): unknown {
    return encrypted ? ENCRYPTED : this.value(payload);
  }

  /**
   * A request's path that may be shown: the segments of sensitive route parameters (`/reset-password/:token` →
   * `/reset-password/[redacted]`) replaced — by the route's pattern, when it has one — then masked as text (token-like
   * segments of unmatched paths too). A pattern that does not line up with the path (wildcards) gives the pattern itself.
   */
  path(path: string, pattern?: string): string {
    if (pattern !== undefined) {
      const names = pattern.split('/');
      const parts = path.split('/');
      const sensitive = (segment: string) => segment.startsWith(':') && this.isSensitive(parameterName(segment));
      if (names.some(sensitive)) {
        if (names.length !== parts.length || names.some((segment) => segment.includes('*'))) return pattern;
        return this.text(names.map((segment, index) => (sensitive(segment) ? REDACTED : parts[index]!)).join('/'));
      }
    }
    return this.text(path);
  }

  /** A URL that may be shown: its path as {@link path} does it, its query string as text (`?token=…` masked); the origin as it is. */
  url(url: string, pattern?: string): string {
    let parsed: URL;
    try {
      parsed = new URL(url, 'http://localhost');
    } catch {
      return this.text(url);
    }
    const origin = /^[a-z][\w+.-]*:\/\//i.test(url) ? parsed.origin : '';
    return `${origin}${this.path(parsed.pathname, pattern)}${parsed.search.length > 1 ? `?${this.text(parsed.search.slice(1))}` : ''}`;
  }

  /**
   * `value` (plain data, as {@link value} gives it) made to fit `maxBytes` of JSON — what one recorded entry may take:
   * long strings and lists are shortened step by step; if even that is too much, a preview of its JSON is all that stays.
   */
  fit(value: unknown, maxBytes = MAX_ENTRY_BYTES): unknown {
    const json = JSON.stringify(value) ?? 'null';
    const bytes = Buffer.byteLength(json);
    if (bytes <= maxBytes) return value;
    for (const limit of [8192, 1024, 128]) {
      const shortened = shorten(value, limit);
      if (Buffer.byteLength(JSON.stringify(shortened) ?? 'null') <= maxBytes) return shortened;
    }
    return { cut: `${bytes} bytes`, preview: json.slice(0, Math.max(0, Math.floor(maxBytes / 2) - 64)) };
  }
}

/** `:token{[a-z]+}?` → `token`. */
function parameterName(segment: string): string {
  return /^:([\w-]+)/.exec(segment)?.[1] ?? segment.slice(1);
}

/** Plain data with every string longer than `limit` cut and every list longer than 100 items shortened. */
function shorten(value: unknown, limit: number, depth = 0): unknown {
  if (typeof value === 'string') return value.length <= limit ? value : `${value.slice(0, limit)}… [cut: ${value.length - limit} more characters]`;
  if (value === null || typeof value !== 'object' || depth > 16) return value;
  if (Array.isArray(value)) {
    const items = value.slice(0, 100).map((item) => shorten(item, limit, depth + 1));
    return value.length > 100 ? [...items, `… [cut: ${value.length - 100} more items]`] : items;
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, shorten(entry, limit, depth + 1)]));
}

/** `text` cut at {@link MAX_ENTRY_BYTES} (UTF-16 units — close enough to bytes for a limit), saying how much was left out. */
function truncate(text: string): string {
  return text.length <= MAX_ENTRY_BYTES ? text : `${text.slice(0, MAX_ENTRY_BYTES)}… [cut: ${text.length - MAX_ENTRY_BYTES} more characters]`;
}

/**
 * An error as text for storage (a failed job's `exception`): name, message, stack and the error's own properties and
 * causes — redacted like a log entry by `redactor` ({@link Redactor.log} for properties, {@link Redactor.text} for the text, cut
 * at {@link MAX_ENTRY_BYTES}). Pass the app's (`app.container.make(Redactor)`), so the names its packages add — the session's
 * cookie — are masked too; without one, the core's key list alone.
 */
export function describeError(error: unknown, redactor: Redactor = new Redactor()): string {
  if (!(error instanceof Error)) return redactor.text(typeof error === 'string' ? error : safeJson(redactor.log({ value: error }).value));
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth < 5; depth++) {
    const own = Object.fromEntries(Object.entries(current).filter(([key]) => key !== 'cause'));
    const properties = Object.keys(own).length > 0 ? `\n${safeJson(redactor.log(own))}` : '';
    parts.push(`${depth > 0 ? 'Caused by: ' : ''}${current.stack ?? `${current.name}: ${current.message}`}${properties}`);
    current = current.cause;
  }
  if (current !== undefined && !(current instanceof Error)) parts.push(`Caused by: ${typeof current === 'string' ? current : safeJson(redactor.log({ value: current }).value)}`);
  return redactor.text(parts.join('\n'));
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
