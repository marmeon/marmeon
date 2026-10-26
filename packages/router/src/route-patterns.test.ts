import { describe, expect, it } from 'vitest';
import { INVALID_PATTERNS, ROUTE_PATTERNS } from './__fixtures__/route-patterns.ts';
import { defineRoutes, everyone, Router, type RouteBinder } from './index.ts';
import { checkedRoutes } from './test-helpers/open-routes.ts';
import { matchParams, patternProblem, tokenizePattern } from './pattern.ts';
import { fillPath, matchesPath } from './url.ts';

class Things implements RouteBinder<{ id: string }> {
  resolveRouteBinding(value: string) {
    return { id: value };
  }
}

describe('tokenizePattern', () => {
  it('reads literals and parameters with their constraint and optional mark', () => {
    expect(tokenizePattern('/archive/:year{[0-9]{4}}/:month{[0-9]{2}}?/x')).toEqual([
      { text: '/archive' },
      { name: 'year', constraint: '[0-9]{4}', optional: false },
      { name: 'month', constraint: '[0-9]{2}', optional: true },
      { text: '/x' },
    ]);
    expect(tokenizePattern('/a/:b?')).toEqual([{ text: '/a' }, { name: 'b', constraint: undefined, optional: true }]);
    expect(tokenizePattern('/')).toEqual([{ text: '/' }]);
  });

  it('keeps a `}` in a class and an escaped brace inside the constraint', () => {
    expect(tokenizePattern('/raw/:text{[}]+}/y')).toEqual([{ text: '/raw' }, { name: 'text', constraint: '[}]+', optional: false }, { text: '/y' }]);
    expect(tokenizePattern('/raw/:text{a\\}b}')).toEqual([{ text: '/raw' }, { name: 'text', constraint: 'a\\}b', optional: false }]);
  });

  it('reads an unterminated constraint as text, which the start then refuses', () => {
    expect(tokenizePattern('/a/:b{[0-9]')).toEqual([{ text: '/a/:b{[0-9]' }]);
    expect(patternProblem('/a/:b{[0-9]')).toContain('never closed');
  });
});

describe.each(ROUTE_PATTERNS)('the pattern $pattern', ({ pattern, names, params, filled, matches, misses }) => {
  it('is read by the tokenizer', () => {
    expect(tokenizePattern(pattern).flatMap((token) => ('name' in token ? [token.name] : []))).toEqual(names);
  });

  it('is filled by fillPath, with every value encoded', () => {
    expect(fillPath('x', pattern, params)).toEqual({ path: filled, rest: {} });
  });

  it('is matched by the browser, which takes a path of the pattern only', () => {
    for (const { path } of matches) expect(matchesPath(pattern, path)).toBe(true);
    for (const path of misses) expect(matchesPath(pattern, path)).toBe(false);
  });

  it('gives its parameters back from a path', () => {
    for (const { path, params: expected } of matches) expect(matchParams(pattern, path)).toEqual(expected);
    for (const path of misses) expect(matchParams(pattern, path)).toBeUndefined();
  });

  it('is held to Route.bind() for each of its parameters, and for no other', () => {
    for (const name of names) {
      expect(() => new Router().load(checkedRoutes((Route) => (Route.bind(name, Things) as any).get(pattern, () => 'x')))).not.toThrow();
    }
    expect(() => new Router().load(checkedRoutes((Route) => (Route.bind('other', Things) as any).get(pattern, () => 'x')))).toThrow(
      `Route.bind('other') needs a :other parameter in ${pattern}.`,
    );
  });
});

describe('a link built from a pattern', () => {
  it('never carries text of the constraint, so it cannot lead to another route', () => {
    expect(fillPath('x', '/archive/:year{[0-9]{4}}/a', { year: 2026 }).path).toBe('/archive/2026/a');
    expect(fillPath('x', '/raw/:text{[}]+}/a', { text: '}' }).path).toBe('/raw/%7D/a');
  });

  it('is built from a name with an underscore or digits', () => {
    expect(fillPath('x', '/u/:user_id/:_n2', { user_id: 1, _n2: 2 }).path).toBe('/u/1/2');
  });

  it.each(['..', '.'])('still refuses [%s], and %s encoded is still a dot segment the link cannot carry', (value) => {
    expect(() => fillPath('x', '/archive/:year{[0-9]{4}}', { year: value })).toThrow('a dot segment leads to another route');
    expect(() => fillPath('x', '/blog/:slug/:page?', { slug: 'a', page: value })).toThrow('a dot segment leads to another route');
  });

  it('encodes `%2E%2E`, `/`, `?` and `#` in a value instead of passing them on', () => {
    expect(fillPath('x', '/blog/:slug', { slug: '%2E%2E' }).path).toBe('/blog/%252E%252E');
    expect(fillPath('x', '/blog/:slug', { slug: 'a/b?c#d' }).path).toBe('/blog/a%2Fb%3Fc%23d');
    expect(fillPath('x', '/archive/:year{[0-9]{4}}', { year: '2026}/..' }).path).toBe('/archive/2026%7D%2F..');
  });
});

describe('a pattern the router cannot read the same way everywhere', () => {
  it.each(INVALID_PATTERNS)('stops the start in $pattern with H13, saying it $problem', ({ pattern, problem }) => {
    const load = () => new Router().load(defineRoutes((Route) => void Route.authorize(everyone).get(pattern, () => 'x')));
    expect(load).toThrow(/\[marmeon:H13\]/);
    expect(load).toThrow(problem);
    expect(load).toThrow(pattern);
  });

  it('is refused after a prefix too, naming the whole pattern', () => {
    expect(() => new Router().load(defineRoutes((Route) => void Route.authorize(everyone).prefix('/users').get('/:user-id', () => 'x')))).toThrow(
      'Route parameter [user-id] in /users/:user-id is no name: use letters, digits and _, starting with a letter or _ (:user_id).',
    );
  });

  it('lets a parameter end a segment and an optional one end the path', () => {
    for (const pattern of ['/a/:x/', '/a/:x/b', '/a/:x/:y?', '/a/:x{[a-z]+\\.json}', '/a/:x{(?:a|b)}', '/a/:x{(?<=a)b}']) expect(patternProblem(pattern)).toBeUndefined();
  });
});
