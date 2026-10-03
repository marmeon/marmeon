/** Keys whose values never reach a log (or a stored error): passwords, tokens, secrets, credentials and cookies. */
export const REDACTED_KEYS = /pass(word)?|secret|token|authorization|cookie|remember|api[-_]?key|signature/i;

/**
 * A copy of `context` with sensitive values replaced by `[redacted]` — by key, at any depth (`password`,
 * `new_password`, `headers.authorization`, `remember_web` …). Messages themselves are not scanned:
 * never put secrets into a log message ({@link redactText} is the safety net for text that may hold some).
 */
export function redact(context: Record<string, unknown>, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    if (REDACTED_KEYS.test(key)) out[key] = '[redacted]';
    else if (depth < 6 && value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Error)) out[key] = redact(value as Record<string, unknown>, depth + 1);
    else out[key] = value;
  }
  return out;
}

// `password=…`, `token: …`, `"api_key":"…"`, `?signature=…&` — a sensitive key followed by its value (not a statement's `?`/`$1`
// placeholder: `where password = ?` stays readable). Matches start at a word's
// beginning only (the lookbehind): otherwise a long word costs quadratic time (a 64 KB string took seconds).
const KEY_VALUE = /(?<![\w-])([\w-]*(?:pass(?:word)?|secret|token|authorization|cookie|remember|api[-_]?key|signature)[\w-]*)("?\s*[:=]\s*"?)(?!\[redacted\]|\?|\$\d)((?:Bearer|Basic)\s+)?([^\s"'&,;}]+)/gi;
// `Authorization: Bearer …` without the key in front (a header value on its own).
const BEARER = /\b(Bearer|Basic)\s+(?!\[redacted\])[\w.~+/=-]+/g;
// `postgres://user:secret@host`, `redis://:secret@host` — the password of a URL.
const URL_PASSWORD = /(?<![\w+.-])([a-z][\w+.-]*:\/\/[^:\s/@]*:)[^@\s/]+@/gi;
// A password hash as a PHC string — `$argon2id$v=19$m=…$salt$hash`, `$scrypt$…` (E125): never shown, wherever it appears.
const PHC_HASH = /\$(?:argon2(?:id|i|d)|scrypt|pbkdf2(?:-sha\d+)?|bcrypt|2[abxy])\$[\w+/=,.$-]*[\w+/=$-]/g;
// An API token (`bc_12|<secret>`, E27) under any prefix: its id stays, the secret goes.
const API_TOKEN = /\b([a-z0-9_]{0,16}?\d+)\|[A-Za-z0-9]{32,}/g;
// A path segment of 32 or more URL-safe characters (`/reset-password/<token>`, a signed link's hash) — kept unless it reads
// like a word or an id (see `looksLikeToken`). Matches start right after a `/` only (no quadratic scan of long words).
const PATH_SEGMENT = /(?<=\/)[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether a long path segment is a secret rather than a name: a hex string (a hash) or a random-looking base64url string —
 * upper- and lower-case letters and digits, few separators. Slugs (`my-long-article-title-2026`) and UUIDs (ids) stay.
 */
function looksLikeToken(segment: string): boolean {
  if (UUID.test(segment)) return false;
  if (/^[0-9a-f]+$/i.test(segment)) return true;
  const separators = segment.length - segment.replaceAll(/[-_]/g, '').length;
  return /\d/.test(segment) && /[a-z]/.test(segment) && /[A-Z]/.test(segment) && separators * 8 <= segment.length;
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

/** What an encrypted payload (a job with `static encrypted`, a queued mail or listener) is shown as — never its contents (E125). */
export const ENCRYPTED = '[encrypted]';

/** The most of one value (a string, a statement, a body) that is shown or recorded (E125) — the rest is cut off. */
export const MAX_ENTRY_BYTES = 64 * 1024;

/** A statement as the `db.query` channel publishes it (`DbQueryMessage`). */
export interface RedactableQuery {
  readonly sql: string;
  readonly parameters: readonly unknown[];
  /** The statement touches a table with secret columns: none of its parameters is shown. */
  readonly secret: boolean;
}

/**
 * The one place that decides what of a value may be shown or recorded (E125) — for the development error page and its
 * Markdown copy, the devtools recorder and telemetry spans alike, also locally:
 *
 * - **by key**, at any depth: {@link REDACTED_KEYS} (passwords, tokens, secrets, cookies, `authorization`, signatures — so also
 *   `set-cookie`, `x-xsrf-token`, `_token`) and the names packages add — the session's cookie (`addKeys`);
 * - **in text**: what {@link redactText} masks (values of sensitive keys, bearer credentials, URL passwords, password hashes,
 *   API tokens) and the values of the added names (`bespoke_session=…`);
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

  /** More names whose values are never shown — a cookie's name (`bespoke_session`), a header, a field. Case does not matter. */
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

  /** `text` without what looks like a secret ({@link redactText} and the added names' values), cut at {@link MAX_ENTRY_BYTES}. */
  text(text: string): string {
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

  /** Headers that may be shown: the values of sensitive ones (`cookie`, `authorization`, `set-cookie`, `x-xsrf-token`) replaced. */
  headers(headers: Headers | Iterable<readonly [string, string]> | Readonly<Record<string, string>>): Record<string, string> {
    const entries = headers instanceof Headers || Symbol.iterator in headers ? [...(headers as Iterable<readonly [string, string]>)] : Object.entries(headers);
    const out: Record<string, string> = {};
    for (const [name, value] of entries) out[name] = this.isSensitive(name) ? REDACTED : this.text(value);
    return out;
  }

  /** A statement that may be shown: with `secret`, no parameter at all (E125); otherwise each one masked like any value. */
  query(query: RedactableQuery): { sql: string; parameters: unknown[] } {
    return {
      sql: this.text(query.sql),
      parameters: query.secret ? query.parameters.map(() => REDACTED) : query.parameters.map((parameter) => this.value(parameter)),
    };
  }

  /**
   * A queued payload that may be shown: an encrypted one (a job with `static encrypted`, a queued mail or listener — it may
   * carry tokens or signed links) only as {@link ENCRYPTED}, never its contents; any other masked like a value (E125).
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
   * `value` (plain data, as {@link value} gives it) made to fit `maxBytes` of JSON — what one recorded entry may take (E125):
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
 * causes — redacted like a log entry ({@link redact} for properties, {@link redactText} for the text).
 */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return redactText(typeof error === 'string' ? error : safeJson(error));
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth < 5; depth++) {
    const own = Object.fromEntries(Object.entries(current).filter(([key]) => key !== 'cause'));
    const properties = Object.keys(own).length > 0 ? `\n${safeJson(redact(own))}` : '';
    parts.push(`${depth > 0 ? 'Caused by: ' : ''}${current.stack ?? `${current.name}: ${current.message}`}${properties}`);
    current = current.cause;
  }
  if (current !== undefined && !(current instanceof Error)) parts.push(`Caused by: ${typeof current === 'string' ? current : safeJson(current)}`);
  return redactText(parts.join('\n'));
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
