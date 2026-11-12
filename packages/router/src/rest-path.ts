/**
 * Reading the rest of a request's path for a `/:name*` route. The value is worked out here from the raw path, never taken from
 * the server's own matching: that one decodes `%2F` into a `/` and passes `//host` on, which the controller would take for a
 * path of this site.
 */

import { localLocation } from './local-location.ts';
import { restSegmentProblem, tokenizePattern } from './pattern.ts';

/** What a request to a rest route comes to: the value for the controller, a redirect to the canonical path, or a 404. */
export type RestResult =
  | { readonly kind: 'value'; readonly value: string }
  | { readonly kind: 'redirect'; readonly location: string }
  | { readonly kind: 'refused' };

interface RestShape {
  readonly name: string;
  /** The raw segments the pattern spends before the rest: a literal's or a parameter's, one each. */
  readonly skipped: number;
  /** The parameters before the rest and the segment each one sits in. */
  readonly before: readonly { readonly name: string; readonly index: number }[];
}

const SHAPES = new Map<string, RestShape | null>();

/** The name of the rest parameter of `pattern` and how many segments come before it, or `undefined` when it has none. */
export function restShape(pattern: string): RestShape | undefined {
  let shape = SHAPES.get(pattern);
  if (shape === undefined) {
    shape = null;
    const tokens = tokenizePattern(pattern);
    const last = tokens.at(-1);
    if (last && 'rest' in last && last.rest) {
      let skipped = 0;
      const before: { name: string; index: number }[] = [];
      for (const token of tokens.slice(0, -1)) {
        if ('text' in token) skipped += token.text.split('/').length - 1;
        else before.push({ name: token.name, index: skipped++ });
      }
      shape = { name: last.name, skipped, before };
    }
    SHAPES.set(pattern, shape);
  }
  return shape ?? undefined;
}

/**
 * The value of the rest parameter of `pattern` for a request to `pathname` (raw, as the URL has it) — checked segment by
 * segment: none may be empty, a dot segment, or hold a `/`, a `\` or a control character once decoded, and a broken percent
 * escape fails too. A single trailing slash is the one path that has a canonical form: a GET or HEAD request is sent to it.
 * `pattern` has a rest parameter; `matched` are the values the server matched for the parameters before it.
 */
export function restParam(pattern: string, pathname: string, method: string, search = '', matched: Readonly<Record<string, string>> = {}): RestResult {
  const shape = restShape(pattern);
  if (!shape || !pathname.startsWith('/')) return { kind: 'refused' };
  const segments = pathname.slice(1).split('/');
  if (pathname === '/') return shape.skipped === 0 ? { kind: 'value', value: '' } : { kind: 'refused' };
  if (segments.length < shape.skipped) return { kind: 'refused' };
  // What the pattern spends on its own: a segment it takes must be a whole, decodable one that is no path of its own.
  for (const raw of segments.slice(0, shape.skipped)) {
    const decoded = decode(raw);
    if (decoded === undefined || decoded === '' || decoded.includes('/')) return { kind: 'refused' };
  }
  // A constraint that spans a `/` (`:a{.+}`) took more than its segment, so the rest would overlap it: the server's value for
  // each parameter has to be the one segment the count gives it.
  for (const { name, index } of shape.before) {
    if (decode(segments[index]!) !== matched[name]) return { kind: 'refused' };
  }
  const rest = segments.slice(shape.skipped);
  const trailingSlash = rest.length > 0 && rest.at(-1) === '';
  if (trailingSlash) rest.pop();
  const decodedRest: string[] = [];
  for (const raw of rest) {
    const decoded = decode(raw);
    if (decoded === undefined || restSegmentProblem(decoded) !== undefined) return { kind: 'refused' };
    decodedRest.push(decoded);
  }
  if (!trailingSlash) return { kind: 'value', value: decodedRest.join('/') };
  const upper = method.toUpperCase();
  if (upper !== 'GET' && upper !== 'HEAD') return { kind: 'refused' };
  // Every segment is checked and the first is not empty, so the target never starts with `//`; `localLocation` makes sure.
  return { kind: 'redirect', location: localLocation(pathname.slice(0, -1) || '/', search) };
}

function decode(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}
