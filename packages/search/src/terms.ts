import { createHash } from 'node:crypto';

/*
 * Turns what a user types into values a driver binds: the tokens (which the built-in drivers search, Postgres through
 * `plainto_tsquery`), a token-only string for `to_tsquery`, an FTS5 `MATCH` of quoted phrases and a Meilisearch filter. Tokens, the
 * `to_tsquery` text, the FTS5 `MATCH` and the filter hold no syntax from the input. `searchText()` gives the cleaned text with its
 * syntax, as `DriverQuery.term` hands it to a driver of a package; no built-in driver reads it. No IO. Internal: `index.ts`
 * exports only the type `ExcerptSegment`.
 */

/** The most characters (code points) of a term that are read; the rest is cut off. */
export const MAX_TERM_LENGTH = 256;
/** The most tokens of a term that are searched. */
export const MAX_TOKENS = 16;
/** The most characters (code points) of one token. */
export const MAX_TOKEN_LENGTH = 100;

/** Opens a highlighted run in an excerpt a driver returns (0xE000, private use). */
export const MARK_START = String.fromCharCode(0xe000);
/** Closes a highlighted run in an excerpt a driver returns (0xE001, private use). */
export const MARK_END = String.fromCharCode(0xe001);

/** One value a filter compares with. */
export type FilterScalar = string | number | boolean;
/** What one filter compares with: one scalar, or a non-empty list meaning "one of". */
export type FilterValue = FilterScalar | readonly FilterScalar[];

/** One run of an excerpt: plain text, or text that matched the search. Never HTML. */
export interface ExcerptSegment {
  readonly text: string;
  readonly match: boolean;
}

// A token is letters, marks and numbers that start with a letter or number. None of the operator characters of tsquery
// (`& | ! ( ) : * ' \ <`), FTS5 (`" * : ( ) ^ +`) or of a Meilisearch filter can be part of one.
const TOKEN = /[\p{L}\p{N}][\p{L}\p{M}\p{N}]*/gu;
const FILTER_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const UNSTORABLE = new RegExp(`[\\x00${MARK_START}${MARK_END}]`, 'g');

/** The first `max` code points of `text`; stops reading at the limit, so a huge input costs no more than a short one. */
function cut(text: string, max: number): string {
  let end = 0;
  let count = 0;
  for (const char of text) {
    if (count === max) return text.slice(0, end);
    end += char.length;
    count += 1;
  }
  return text;
}

/**
 * The user's text as `DriverQuery.term` carries it, for a driver to bind, never to splice: at most {@link MAX_TERM_LENGTH}
 * characters of {@link normalizedText}, the same form as the indexed text (so `ab` NUL `cd` reads `abcd`, as the indexed text does).
 */
export function searchText(term: string): string {
  // Cut before normalizing as well, so the normalization never reads more than a bounded prefix of a long input.
  return normalizedText(cut(term, MAX_TERM_LENGTH), MAX_TERM_LENGTH);
}

/** The tokens of a term: at most {@link MAX_TOKENS}, each at most {@link MAX_TOKEN_LENGTH} characters. Empty: search nothing. */
export function tokens(term: string): readonly string[] {
  const found: string[] = [];
  for (const [token] of searchText(term).matchAll(TOKEN)) {
    found.push(cut(token, MAX_TOKEN_LENGTH));
    if (found.length === MAX_TOKENS) break;
  }
  return Object.freeze(found);
}

/** A copy of `list` once every entry is a token within the limits; callers build from the copy, never from `list` again. */
function requireTokens(list: readonly string[], caller: string): readonly string[] {
  if (list.length === 0) throw new TypeError(`${caller}() needs at least one token; a term without tokens searches nothing.`);
  if (list.length > MAX_TOKENS) throw new TypeError(`${caller}() takes at most ${MAX_TOKENS} tokens, not ${list.length}.`);
  // Only strings of token shape within the limits of `tokens()` reach the query strings: anything else could carry operators.
  const copy = Array.from(list);
  for (const token of copy) {
    if (typeof token !== 'string' || token.match(TOKEN)?.[0] !== token || cut(token, MAX_TOKEN_LENGTH) !== token) {
      throw new TypeError(`${caller}() takes only tokens from tokens(); ${JSON.stringify(cut(String(token), MAX_TOKEN_LENGTH))} is not one.`);
    }
  }
  return Object.freeze(copy);
}

/** The `to_tsquery` text for a prefix search: every token required, the last one as a prefix (`t1 & t2:*`). Bind it. */
export function postgresPrefixQuery(list: readonly string[]): string {
  return `${requireTokens(list, 'postgresPrefixQuery').join(' & ')}:*`;
}

/** The FTS5 `MATCH` text: every token as a quoted phrase, the last one as a prefix when `prefix` (`"t1" "t2"*`). Bind it. */
export function fts5Match(list: readonly string[], prefix: boolean): string {
  return requireTokens(list, 'fts5Match').map((token) => `"${token}"`).join(' ') + (prefix ? '*' : '');
}

function quote(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/**
 * What a Meilisearch document stores in `f_<name>` for one filter value, and what {@link meilisearchFilter} compares it with: the
 * lowercase hex SHA-256 of the value's type and text (`s:` a string as JSON, `n:` a number, `b:` a boolean). Meilisearch trims,
 * decomposes and lowercases facet strings and matches a string that reads as a number against numbers, so raw values would let
 * `ALICE`, `alice ` or `7.0` pass a filter set to `alice` or `7`; filters decide what a user may see, so they must compare
 * exactly. The hash keeps every value apart, needs no escaping and no number syntax. A `TypeError` for anything but a string, a
 * finite number or a boolean (`undefined` and `null` included).
 */
export function meilisearchFilterValue(value: FilterScalar, name?: string): string {
  const what = name === undefined ? 'A search filter value' : `The search filter "${name}"`;
  let canonical: string;
  // JSON keeps a lone surrogate as an escape; UTF-8 would turn it into U+FFFD and make two strings one.
  if (typeof value === 'string') canonical = `s:${JSON.stringify(value)}`;
  else if (typeof value === 'boolean') canonical = value ? 'b:true' : 'b:false';
  else if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${what} must be a finite number, not ${String(value)}.`);
    // String(-0) is '0', so both zeros store and match alike, as they compare equal.
    canonical = `n:${String(value)}`;
  } else {
    // undefined and null never mean "no filter": a missing tenant must not show every tenant.
    const actual: unknown = value;
    const kind = actual === null ? 'null' : Array.isArray(actual) ? 'a list' : typeof actual;
    throw new TypeError(`${what} must be a string, a finite number or a boolean, not ${kind}.`);
  }
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * The Meilisearch `filter` expression: every filter ANDed, as `f_<name> = "<hash>"` or `f_<name> IN ["<hash>", …]` with each
 * value through {@link meilisearchFilterValue}, plus `locale = "…"` when a locale is given. Empty without filters and locale. A
 * `TypeError` for: filters that are not a plain object of enumerable string keys, a name outside `/^[a-z][a-z0-9_]{0,63}$/`, an
 * empty list, a locale that is empty, no string or not well-formed, and any value that is not a string, a finite number or a
 * boolean (`undefined` and `null` included).
 */
export function meilisearchFilter(filters: Readonly<Record<string, FilterValue>>, locale?: string): string {
  // Only own enumerable string keys are read: an inherited, hidden, symbol-keyed or Map-held filter would silently drop out, so
  // anything but a plain object of such keys is refused.
  const prototype: unknown = typeof filters === 'object' && filters !== null ? Object.getPrototypeOf(filters) : undefined;
  if ((prototype !== Object.prototype && prototype !== null) || Reflect.ownKeys(filters).length !== Object.keys(filters).length) {
    throw new TypeError('The search filters must be a plain object with enumerable string keys.');
  }
  const parts: string[] = [];
  for (const [name, value] of Object.entries(filters)) {
    if (!FILTER_NAME.test(name)) throw new TypeError(`${JSON.stringify(name)} is not a search filter name.`);
    if (Array.isArray(value)) {
      if (value.length === 0) throw new TypeError(`The search filter "${name}" got an empty list, which would match nothing.`);
      // Array.from hands a hole to the encoder as undefined; map() would skip it.
      parts.push(`f_${name} IN [${Array.from(value, (item: FilterScalar) => `"${meilisearchFilterValue(item, name)}"`).join(', ')}]`);
    } else {
      parts.push(`f_${name} = "${meilisearchFilterValue(value as FilterScalar, name)}"`);
    }
  }
  if (locale !== undefined) {
    // A lone surrogate would leave as an escape that Meilisearch's JSON parser refuses.
    if (typeof locale !== 'string' || locale === '' || !locale.isWellFormed()) {
      throw new TypeError('The search locale must be a non-empty, well-formed string.');
    }
    parts.push(`locale = ${quote(locale)}`);
  }
  return parts.join(' AND ');
}

/**
 * Splits an excerpt a driver marked with {@link MARK_START} and {@link MARK_END} into segments. An end without a start is dropped,
 * a start without an end marks the rest; empty runs are left out and neighbouring runs of the same kind are joined.
 */
export function excerptSegments(text: string): readonly ExcerptSegment[] {
  const segments: { text: string; match: boolean }[] = [];
  let match = false;
  let run = '';
  const close = () => {
    if (run === '') return;
    const last = segments.at(-1);
    if (last?.match === match) last.text += run;
    else segments.push({ text: run, match });
    run = '';
  };
  for (const char of text) {
    if (char === MARK_START || char === MARK_END) {
      close();
      match = char === MARK_START;
    } else {
      run += char;
    }
  }
  close();
  return Object.freeze(segments.map((segment) => Object.freeze(segment)));
}

/**
 * Indexed text without NUL (Postgres cannot store it) and without the excerpt markers, so content cannot forge a highlight; the
 * neighbours of a removed character join. A lone surrogate becomes U+FFFD, since a JSON parser on the other end may refuse it.
 */
export function cleanText(text: string): string {
  return text.replace(UNSTORABLE, '').toWellFormed();
}

/** The most marks in a row that {@link normalizedText} keeps, as the stream-safe format of UAX #15 allows. */
export const MAX_MARK_RUN = 30;
// The characters whose NFKD starts with a non-starter: the marks, and the halfwidth sound marks U+FF9E and U+FF9F (category Lm).
const MARK_RUN = new RegExp(`([\\p{M}\\uFF9E\\uFF9F]{${MAX_MARK_RUN}})[\\p{M}\\uFF9E\\uFF9F]+`, 'gu');
// NFKC composes at most four characters into one (the longest canonical decomposition) and makes at most 18 of one (U+FDFA).
const NFKC_SHRINK = 4;
const NFKC_GROWTH = 18;
// The characters at the end of a cut prefix whose normalization the text after the cut may change: two stream-safe segments.
const UNSETTLED = 2 * (MAX_MARK_RUN + 1);

/** The first `max` code points of `text`, and whether that was all of it. */
function prefix(text: string, max: number): { readonly text: string; readonly whole: boolean } {
  const head = cut(text, max);
  return { text: head, whole: head.length === text.length };
}

/**
 * The first `max` code points of the NFKC form of the cleaned text ({@link cleanText}): the form of a search term and of indexed
 * text alike. A run of more than {@link MAX_MARK_RUN} marks keeps its first ones, so the normalization stays linear (it sorts a run
 * of marks), and the normalization reads a prefix that grows by a fixed step only until it surely fills `max`: a huge text costs
 * no more than about four times `max`, and one pass adds at most one step of new text, so its result stays below 19 steps.
 * @internal
 */
export function normalizedText(text: string, max: number): string {
  const safe = cleanText(text).replace(MARK_RUN, '$1');
  const settled = max + NFKC_GROWTH * UNSETTLED;
  const most = NFKC_SHRINK * settled;
  for (let read = settled; ; read = Math.min(read + settled, most)) {
    const raw = prefix(safe, read);
    const normalized = raw.text.normalize('NFKC');
    // The end of a cut prefix may normalize differently once the text after it follows: only what lies before it is final.
    if (raw.whole || read === most || !prefix(normalized, settled - 1).whole) return cut(normalized, max);
  }
}
