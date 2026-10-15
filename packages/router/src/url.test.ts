import { describe, expect, it } from 'vitest';
import { fillPath, localLocation, urlFor } from './url.ts';

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

  it('keeps a derived location on this site: leading slashes and backslashes collapse to one', () => {
    for (const pathname of ['//evil.example/x', '///evil.example/x', '/\\evil.example/x', '\\\\evil.example/x', '/\\/evil.example/x']) {
      expect(localLocation(pathname, '?bad=1')).toBe('/evil.example/x?bad=1');
    }
    expect(localLocation('/a//b', '?q=1')).toBe('/a//b?q=1');
    expect(localLocation('/%2f/evil')).toBe('/%2f/evil');
    expect(localLocation('/')).toBe('/');
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
    expect(() => urlFor(lookup, 'nope')).toThrow('Route [nope] is not defined.');
  });
});
