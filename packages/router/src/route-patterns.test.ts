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
      { name: 'year', constraint: '[0-9]{4}', optional: false, rest: false },
      { name: 'month', constraint: '[0-9]{2}', optional: true, rest: false },
      { text: '/x' },
    ]);
    expect(tokenizePattern('/a/:b?')).toEqual([{ text: '/a' }, { name: 'b', constraint: undefined, optional: true, rest: false }]);
    expect(tokenizePattern('/')).toEqual([{ text: '/' }]);
  });

  it('keeps a `}` in a class and an escaped brace inside the constraint', () => {
    expect(tokenizePattern('/raw/:text{[}]+}/y')).toEqual([{ text: '/raw' }, { name: 'text', constraint: '[}]+', optional: false, rest: false }, { text: '/y' }]);
    expect(tokenizePattern('/raw/:text{a\\}b}')).toEqual([{ text: '/raw' }, { name: 'text', constraint: 'a\\}b', optional: false, rest: false }]);
  });

  it('reads /:name* as a parameter that takes the rest of the path', () => {
    expect(tokenizePattern('/docs/:page*')).toEqual([{ text: '/docs' }, { name: 'page', constraint: undefined, optional: false, rest: true }]);
    expect(tokenizePattern('/:path*')).toEqual([{ name: 'path', constraint: undefined, optional: false, rest: true }]);
  });

  it('reads an unterminated constraint as text, which the start then refuses', () => {
    expect(tokenizePattern('/a/:b{[0-9]')).toEqual([{ text: '/a/:b{[0-9]' }]);
    expect(patternProblem('/a/:b{[0-9]')).toContain('never closed');
  });
});

describe('matchParams and trailing slashes', () => {
  it('ignores any number of slashes at the end, and only there', () => {
    expect(matchParams('/teams/:team', '/teams/7///')).toEqual({ team: '7' });
    expect(matchParams('/teams/:team', '/teams/7/')).toEqual({ team: '7' });
    expect(matchParams('/teams/:team', '/teams/7//x')).toBeUndefined();
    expect(matchParams('/', '///')).toEqual({});
    expect(matchParams('/files/:path{.+}', '/files/a//b//')).toEqual({ path: 'a//b' });
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

describe('the rest of the path', () => {
  it('is matched raw, with nothing, one segment or many, and a trailing slash ignored', () => {
    expect(matchParams('/docs/:page*', '/docs')).toEqual({ page: '' });
    expect(matchParams('/docs/:page*', '/docs/a/b')).toEqual({ page: 'a/b' });
    expect(matchParams('/docs/:page*', '/docs/a%2Fb/')).toEqual({ page: 'a%2Fb' });
    expect(matchParams('/:path*', '/')).toEqual({ path: '' });
    expect(matchParams('/docs/:page*', '/docsx')).toBeUndefined();
    expect(matchesPath('/:locale/:path*', '/de/a/b')).toBe(true);
  });

  it.each([
    ['/a/:x*/b', 'it has to be last'],
    ['/a/:x*/:y', 'it has to be last'],
    ['/a/:x*{a}', 'no constraint'],
    ['/a/:x{a}*', 'followed by text in its segment'],
    ['/a/:x*?', 'no constraint and no ?'],
    ['/a/:x*y', 'it has to be last'],
    ['/a/:*', 'is no name'],
  ])('stops the start in %s with H13', (pattern, problem) => {
    const load = () => new Router().load(defineRoutes((Route) => void Route.authorize(everyone).get(pattern, () => 'x')));
    expect(load).toThrow(/\[marmeon:H13\]/);
    expect(load).toThrow(problem);
  });

  it('is accepted as the last parameter, after parameters and a prefix', () => {
    for (const pattern of ['/:path*', '/docs/:page*', '/:locale/docs/:page*', '/:a/:b/:rest*']) expect(patternProblem(pattern)).toBeUndefined();
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
