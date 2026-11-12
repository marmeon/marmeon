import { describe, expect, it } from 'vitest';
import { fillPath, urlFor } from './url.ts';

describe('fillPath / urlFor', () => {
  const routes = new Map([
    ['teams.show', { path: '/teams/:team{[a-z]+}/:tab?' }],
    ['home', { path: '/' }],
  ]);
  const lookup = { findByName: (name: string) => routes.get(name) };

  it('refuses `.` and `..` as parameter values, since a link ending in one resolves to another route', () => {
    expect(() => fillPath('posts.show', '/posts/:slug', { slug: '..' })).toThrow('Parameter [slug] of route [posts.show] cannot be [..]');
    expect(() => fillPath('posts.show', '/posts/:slug', { slug: '.' })).toThrow('cannot be [.]');
    expect(() => urlFor({ findByName: () => ({ path: '/posts/:slug' }) }, 'posts.show', { slug: '..' })).toThrow('cannot be [..]');
    for (const slug of ['...', '.a', 'a.', 'a..b']) expect(fillPath('posts.show', '/posts/:slug', { slug }).path).toBe(`/posts/${slug}`);
  });

  it('fills required, constrained and optional parameters and returns the rest', () => {
    expect(fillPath('teams.show', '/teams/:team{[a-z]+}/:tab?', { team: 'core' })).toEqual({ path: '/teams/core', rest: {} });
    expect(fillPath('teams.show', '/teams/:team{[a-z]+}/:tab?', { team: 'core', tab: 'members', page: 2 })).toEqual({
      path: '/teams/core/members',
      rest: { page: 2 },
    });
    expect(() => fillPath('teams.show', '/teams/:team/:tab?', { team: '' })).toThrow('Missing required parameter [team] for route [teams.show].');
  });

  it('builds URLs through any lookup — the router or the browser manifest', () => {
    expect(urlFor(lookup, 'teams.show', { team: 'core' }, { q: 'x' })).toBe('/teams/core?q=x');
    expect(urlFor(lookup, 'home')).toBe('/');
    expect(() => urlFor(lookup, 'nope')).toThrow('[marmeon:H4] Route [nope] is not defined.');
  });
});

describe('fillPath with the rest of the path', () => {
  it('encodes each segment and keeps the / between them', () => {
    expect(fillPath('x', '/help/:path*', { path: 'a/b' }).path).toBe('/help/a/b');
    expect(fillPath('x', '/help/:path*', { path: 'a b/c' }).path).toBe('/help/a%20b/c');
    expect(fillPath('x', '/help/:path*', { path: 'a?b#c/d' }).path).toBe('/help/a%3Fb%23c/d');
    expect(fillPath('x', '/:path*', { path: 'a/b' }).path).toBe('/a/b');
  });

  it('adds nothing for an empty or missing value, and leaves other parameters to the query', () => {
    expect(fillPath('x', '/help/:path*', { path: '' })).toEqual({ path: '/help', rest: {} });
    expect(fillPath('x', '/help/:path*')).toEqual({ path: '/help', rest: {} });
    expect(fillPath('x', '/:path*', {})).toEqual({ path: '/', rest: {} });
    expect(fillPath('x', '/help/:path*', { path: 'a', tab: 'b' })).toEqual({ path: '/help/a', rest: { tab: 'b' } });
  });

  it.each(['a//b', '/a', 'a/', '..', 'a/./b', 'a\\b', 'a\u0000b', 'a\nb'])('refuses [%j], the path the server would refuse', (path) => {
    expect(() => fillPath('help.page', '/help/:path*', { path })).toThrow(/Parameter \[path\] of route \[help\.page\] cannot be/);
  });

  it('names the leading slash when that is the mistake', () => {
    expect(() => fillPath('help.page', '/help/:path*', { path: '/a' })).toThrow('leave out the leading /');
  });

  it('takes a string only', () => {
    expect(() => fillPath('help.page', '/help/:path*', { path: 7 })).toThrow('takes the rest of the path as a string');
  });

  it('leaves a {.+} parameter as it was: the / of its value is encoded', () => {
    expect(fillPath('x', '/files/:path{.+}', { path: 'a/b' }).path).toBe('/files/a%2Fb');
  });
});
