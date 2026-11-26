import { describe, expect, it } from 'vitest';
import { fillPath, localePath, urlFor, withoutLocale } from './url.ts';

describe('fillPath / urlFor', () => {
  const routes = new Map([
    ['teams.show', { path: '/teams/:team{[a-z]+}/:tab?' }],
    ['home', { path: '/' }],
  ]);
  const lookup = { findByName: (name: string) => routes.get(name), unprefixedLocale: undefined, locales: undefined };

  it('refuses `.` and `..` as parameter values, since a link ending in one resolves to another route', () => {
    expect(() => fillPath('posts.show', '/posts/:slug', { slug: '..' })).toThrow('Parameter [slug] of route [posts.show] cannot be [..]');
    expect(() => fillPath('posts.show', '/posts/:slug', { slug: '.' })).toThrow('cannot be [.]');
    expect(() => urlFor({ findByName: () => ({ path: '/posts/:slug' }), unprefixedLocale: undefined, locales: undefined }, 'posts.show', { slug: '..' })).toThrow('cannot be [..]');
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

  it('refuses a value before the rest that the server would refuse, and leaves a route without a rest alone', () => {
    expect(fillPath('x', '/files/:folder/:path*', { folder: 'a b', path: 'c/d' }).path).toBe('/files/a%20b/c/d');
    for (const folder of ['a/b', 'a\\b', 'a\u0000b']) {
      expect(() => fillPath('files.show', '/files/:folder/:path*', { folder, path: 'c' })).toThrow(/Parameter \[folder\] of route \[files\.show\] cannot be/);
    }
    expect(fillPath('x', '/files/:folder', { folder: 'a/b' }).path).toBe('/files/a%2Fb');
  });

  it('takes a string only', () => {
    expect(() => fillPath('help.page', '/help/:path*', { path: 7 })).toThrow('takes the rest of the path as a string');
  });

  it('leaves a {.+} parameter as it was: the / of its value is encoded', () => {
    expect(fillPath('x', '/files/:path{.+}', { path: 'a/b' }).path).toBe('/files/a%2Fb');
  });
});

describe('the locale without a prefix', () => {
  const routes = new Map([
    ['about', { path: '/:locale/about', localized: true }],
    ['help', { path: '/:locale/help/:path*', localized: true }],
    ['home', { path: '/:locale', localized: true }],
    ['legal', { path: '/legal' }],
  ]);
  const lookup = (unprefixedLocale?: string) => ({ findByName: (name: string) => routes.get(name), unprefixedLocale, locales: ['de', 'en'] });

  it('builds the page of that locale without its prefix, and the others with theirs', () => {
    expect(urlFor(lookup('de'), 'about', { locale: 'de' })).toBe('/about');
    expect(urlFor(lookup('de'), 'about', { locale: 'en' })).toBe('/en/about');
    expect(urlFor(lookup('de'), 'home', { locale: 'de' })).toBe('/');
    expect(urlFor(lookup('de'), 'home', { locale: 'en' })).toBe('/en');
    expect(urlFor(lookup('de'), 'help', { locale: 'de', path: 'a/b' })).toBe('/help/a/b');
  });

  it('never puts the locale into the query, and keeps the other values there', () => {
    expect(urlFor(lookup('de'), 'about', { locale: 'de', ref: 'x' }, { q: '1' })).toBe('/about?ref=x&q=1');
    expect(urlFor(lookup('de'), 'about', { locale: 'de' })).not.toContain('locale');
  });

  it('keeps the prefix of every locale when none is unprefixed', () => {
    expect(urlFor(lookup(), 'about', { locale: 'de' })).toBe('/de/about');
    expect(urlFor(lookup(undefined), 'home', { locale: 'de' })).toBe('/de');
  });

  it('leaves a route that is not localized alone', () => {
    expect(urlFor(lookup('de'), 'legal', { locale: 'de' })).toBe('/legal?locale=de');
  });

  it('builds a localized path for one locale: no prefix for the unprefixed one and for no locale at all', () => {
    expect(withoutLocale('/:locale/about')).toBe('/about');
    expect(withoutLocale('/:locale')).toBe('/');
    expect(localePath('about', '/:locale/about', {}, undefined, 'de', ['de', 'en'])).toBe('/about');
    expect(localePath('about', '/:locale/about', {}, 'en', 'de', ['de', 'en'])).toBe('/en/about');
    expect(localePath('about', '/:locale/about', {}, 'de', undefined, ['de', 'en'])).toBe('/de/about');
    expect(localePath('help', '/:locale/help/:slug', { slug: 'a b', locale: 'fr' }, 'de', 'de', ['de', 'en'])).toBe('/help/a%20b');
  });

  it('keeps the prefix of a page whose address without one would start with a locale, without throwing', () => {
    const supported = ['de', 'en'];
    for (const [slug, path] of [['EN', '/de/EN'], ['De', '/de/De'], ['en', '/de/en'], ['english', '/english']] as const) {
      expect(localePath('page', '/:locale/:slug', { slug }, 'de', 'de', supported), slug).toBe(path);
    }
    // The address without a locale (x-default) is the page of the unprefixed locale: it keeps the prefix as well.
    expect(localePath('page', '/:locale/:slug', { slug: 'en' }, undefined, 'de', supported)).toBe('/de/en');
    // Without a locale without a prefix there is nothing to keep.
    expect(localePath('page', '/:locale/:slug', { slug: 'en' }, undefined, undefined, supported)).toBe('/en');
    expect(urlFor({ findByName: () => ({ path: '/:locale/:slug', localized: true }), unprefixedLocale: 'de', locales: supported }, 'page', { locale: 'de', slug: 'EN' })).toBe('/de/EN');
    // Locales not known: the prefix stays, so `en` is never read as the home of another locale.
    expect(urlFor({ findByName: () => ({ path: '/:locale/:slug', localized: true }), unprefixedLocale: 'de', locales: undefined }, 'page', { locale: 'de', slug: 'en' })).toBe('/de/en');
    expect(localePath('page', '/:locale/:slug', { slug: 'en' }, 'de', 'de', undefined)).toBe('/de/en');
  });
});
