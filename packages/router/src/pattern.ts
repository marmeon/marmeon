/**
 * Reading route patterns — the one tokenizer behind URLs, the browser's path comparison, the bind check, the server and the
 * tables. Free of imports: the browser loads it through `url.ts`.
 */

/** A literal stretch of a route pattern. */
export interface LiteralToken {
  readonly text: string;
}

/** A parameter of a route pattern, with the `/` before it: `/:year{[0-9]{4}}` or `/:page?`. */
export interface ParameterToken {
  readonly name: string;
  /** The regular expression between the braces, without them. */
  readonly constraint: string | undefined;
  readonly optional: boolean;
  /** `/:path*`: the whole rest of the path, as one value (zero or more segments). Always the last token, with no constraint. */
  readonly rest: boolean;
}

export type PatternToken = LiteralToken | ParameterToken;

/**
 * Reads a route pattern (`/users/:user/links/:link?`, `/archive/:year{[0-9]{4}}`) into literals and parameters — the one reading
 * of a pattern for URLs, the browser, the bind check, the server and the tables. A constraint runs to the `}` that closes its
 * `{`: braces nest, a character class (`[}]`) and a backslash escape are skipped. A constraint that is never closed is text ({@link patternProblem} refuses it).
 * A name is whatever follows `/:` up to `/`, `{`, `?` or `*`; a `*` after it makes the parameter the rest of the path. Whether it is a valid one is {@link isParameterName}'s to say.
 */
export function tokenizePattern(pattern: string): readonly PatternToken[] {
  const tokens: PatternToken[] = [];
  let text = '';
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] !== '/' || pattern[i + 1] !== ':') {
      text += pattern[i++];
      continue;
    }
    let cursor = i + 2;
    while (cursor < pattern.length && !'/{?*'.includes(pattern[cursor]!)) cursor++;
    const name = pattern.slice(i + 2, cursor);
    const rest = pattern[cursor] === '*';
    if (rest) cursor++;
    let constraint: string | undefined;
    if (pattern[cursor] === '{') {
      const end = closingBrace(pattern, cursor + 1);
      if (end === -1) {
        text += pattern.slice(i);
        break;
      }
      constraint = pattern.slice(cursor + 1, end);
      cursor = end + 1;
    }
    const optional = pattern[cursor] === '?';
    if (text) tokens.push({ text });
    text = '';
    tokens.push({ name, constraint, optional, rest });
    i = cursor + (optional ? 1 : 0);
  }
  if (text) tokens.push({ text });
  return tokens;
}

/** The index of the `}` closing a constraint whose content begins at `from`, or -1. */
function closingBrace(pattern: string, from: number): number {
  let inClass = false;
  let depth = 1;
  for (let i = from; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '\\') i++;
    else if (inClass) inClass = char !== ']';
    else if (char === '[') inClass = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return i;
  }
  return -1;
}

/** Whether `name` can name a route parameter: letters, digits and `_`, not starting with a digit. */
export function isParameterName(name: string): boolean {
  return /^[A-Za-z_]\w*$/.test(name);
}

/**
 * What keeps `pattern` from being read the same way by the server, `fillPath`, the browser and the sitemap — or `undefined`
 * when it is fine. The server's router reads a parameter followed by text in its segment (`/:x.json`) or an optional parameter
 * before more path (`/:x?/b`) differently, and a repeated name or a named group in a constraint breaks the browser's matching.
 */
export function patternProblem(pattern: string): string | undefined {
  const tokens = tokenizePattern(pattern);
  const seen = new Set<string>();
  for (const [index, token] of tokens.entries()) {
    if ('text' in token) {
      if (/\/:[^/{?]*\{/.test(token.text)) return `Route pattern ${pattern} has a constraint that is never closed: every { needs its }.`;
      continue;
    }
    if (!isParameterName(token.name)) {
      return `Route parameter [${token.name}] in ${pattern} is no name: use letters, digits and _, starting with a letter or _ (:user_id).`;
    }
    if (seen.has(token.name)) return `Route parameter [${token.name}] appears twice in ${pattern}: give each parameter its own name.`;
    seen.add(token.name);
    if (token.constraint !== undefined && /\(\?<[^=!]/.test(token.constraint)) {
      return `The constraint of parameter [${token.name}] in ${pattern} names a group: use (…) or (?:…) without a name.`;
    }
    const next = tokens[index + 1];
    if (token.rest) {
      if (token.constraint !== undefined || token.optional) return `Parameter [${token.name}*] in ${pattern} takes the rest of the path: it has no constraint and no ?.`;
      if (next !== undefined) return `Parameter [${token.name}*] in ${pattern} takes the rest of the path: it has to be last.`;
    }
    if (token.optional && next !== undefined) return `Optional parameter [${token.name}] in ${pattern} is not last: only the last parameter of a path may end in ?.`;
    if (next !== undefined && 'text' in next && !next.text.startsWith('/')) {
      return `Parameter [${token.name}] in ${pattern} is followed by text in its segment: a parameter fills a whole segment (put the text into its constraint, or after a /).`;
    }
  }
  return undefined;
}

/**
 * The parameters of `pathname` read against `pattern`, as they stand in the path (not decoded); `undefined` when the path is
 * none of the pattern's. An optional parameter the path leaves out is no key. A trailing slash is ignored.
 */
export function matchParams(pattern: string, pathname: string): Record<string, string> | undefined {
  let source = '';
  for (const token of tokenizePattern(pattern)) {
    if ('text' in token) {
      source += escapeRegExp(token.text);
      continue;
    }
    const group = isParameterName(token.name) ? `?<${token.name}>` : '';
    // The rest of the path is nothing at all or a slash and the remainder, read raw like every other parameter.
    if (token.rest) {
      source += `(?:/(${group}.*))?`;
      continue;
    }
    const segment = `/(${group}${token.constraint ?? '[^/]+'})`;
    source += token.optional ? `(?:${segment})?` : segment;
  }
  // The lookbehind starts a match only at the first slash of a run: linear on a long run that does not reach the end.
  const trimmed = pathname.length > 1 ? pathname.replace(/(?<!\/)\/+$/, '') : pathname;
  const found = new RegExp(`^${source || '/'}$`).exec(trimmed || '/');
  if (!found) return undefined;
  const params: Record<string, string> = {};
  for (const [name, value] of Object.entries(found.groups ?? {})) if (value !== undefined) params[name] = value;
  // The rest of the path left out is `''`, as the server gives it.
  for (const token of tokenizePattern(pattern)) if ('rest' in token && token.rest) params[token.name] ??= '';
  return params;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Why `decoded` — one segment of the rest of a path, percent-decoded — cannot be part of it, or `undefined`: empty, a dot
 * segment, or holding a `/`, a `\` or a control character. With these refused, `'/' + path` is always a path of this site.
 * One rule for the server, which reads a request, and for `fillPath`, which builds a link.
 */
export function restSegmentProblem(decoded: string): string | undefined {
  if (decoded === '') return 'is empty';
  if (decoded === '.' || decoded === '..') return 'is a dot segment';
  if (decoded.includes('/')) return 'contains a /';
  if (decoded.includes('\\')) return 'contains a \\';
  // oxlint-disable-next-line no-control-regex -- control characters are exactly what it refuses
  if (/[\u0000-\u001f\u007f]/.test(decoded)) return 'contains a control character';
  return undefined;
}
