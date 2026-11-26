import { describe, expect, it } from 'vitest';
import { matchesRoute, resolveRoute, routeEntry } from './routes.ts';

const routes = {
  'about.index': { method: 'get', path: '/:locale/about', localized: true },
  'about.feature': { method: 'get', path: '/:locale/about/:feature', localized: true },
  'people.show': { method: 'get', path: '/people/:person' },
  'profile.show': { method: 'get', path: '/:locale/:username', localized: true },
} as const;

describe('resolveRoute with the locale of the page', () => {
  it('fills it into a localized route that is given none', () => {
    expect(resolveRoute(routes, 'about.index', { pageLocale: 'de' }).url).toBe('/de/about');
    expect(resolveRoute(routes, 'about.feature', { params: { feature: 'routes' }, query: { tab: 'one' }, pageLocale: 'de-AT' }).url).toBe('/de-AT/about/routes?tab=one');
  });

  it('keeps an explicit locale over the page locale', () => {
    expect(resolveRoute(routes, 'about.index', { params: { locale: 'en' }, pageLocale: 'de' }).url).toBe('/en/about');
  });

  it('gives a route that is not localized no locale', () => {
    expect(resolveRoute(routes, 'people.show', { params: { person: 7 }, pageLocale: 'de' }).url).toBe('/people/7');
  });

  it('still needs a locale when neither is given', () => {
    expect(() => resolveRoute(routes, 'about.index', {})).toThrow('Missing required parameter [locale] for route [about.index].');
    expect(() => resolveRoute(routes, 'about.index')).toThrow('Missing required parameter [locale]');
  });

  it('fails loudly for the positional form and for a key it does not know', () => {
    const untyped = resolveRoute as (...args: unknown[]) => unknown;
    expect(() => untyped(routes, 'people.show', { person: 7 })).toThrow(TypeError);
    expect(() => untyped(routes, 'people.show', { person: 7 })).toThrow('not [person]');
    expect(() => untyped(routes, 'people.show', undefined, { tab: 'one' })).toThrow('takes { params, query, pageLocale, urlLocales }');
    expect(() => untyped(routes, 'about.index', undefined, undefined, { locale: 'de' })).toThrow(TypeError);
    expect(() => untyped(routes, 'about.index', 'de')).toThrow(TypeError);
  });

  it('types the options object only', () => {
    // @ts-expect-error a fourth argument is gone
    const tooMany = () => resolveRoute(routes, 'about.index', {}, {});
    // @ts-expect-error an unknown key
    const unknown = () => resolveRoute(routes, 'about.index', { locale: 'de' });
    expect([tooMany, unknown]).toHaveLength(2);
  });

  it('keeps a locale that is no language inside one path segment of this site', () => {
    for (const locale of ['//evil.example', '/\\evil.example', 'a/b']) {
      const { url } = resolveRoute(routes, 'about.index', { params: { locale }, pageLocale: 'de' });
      expect(url).toMatch(/^\/[^/]+\/about$/);
    }
    expect(() => resolveRoute(routes, 'about.index', { params: { locale: '..' }, pageLocale: 'de' })).toThrow('a dot segment');
  });
});

describe('resolveRoute with the locale without a prefix', () => {
  const mode = { urlLocales: { unprefixed: 'de', supported: ['en', 'de'] } } as const;

  it('builds the page of that locale without its prefix, any other with it', () => {
    expect(resolveRoute(routes, 'about.index', { pageLocale: 'de', ...mode }).url).toBe('/about');
    expect(resolveRoute(routes, 'about.feature', { params: { feature: 'routes' }, query: { tab: 'one' }, pageLocale: 'de', ...mode }).url).toBe('/about/routes?tab=one');
    expect(resolveRoute(routes, 'about.index', { pageLocale: 'en', ...mode }).url).toBe('/en/about');
  });

  it('takes an explicit locale the same way, and leaves it out of the query', () => {
    expect(resolveRoute(routes, 'about.index', { params: { locale: 'de' }, pageLocale: 'en', ...mode }).url).toBe('/about');
    expect(resolveRoute(routes, 'about.index', { params: { locale: 'en' }, pageLocale: 'de', ...mode }).url).toBe('/en/about');
  });

  it('keeps the prefix of a page whose address without it would start with a locale (a user named EN)', () => {
    expect(resolveRoute(routes, 'profile.show', { params: { username: 'EN' }, pageLocale: 'de', ...mode }).url).toBe('/de/EN');
    expect(resolveRoute(routes, 'profile.show', { params: { username: 'ada' }, pageLocale: 'de', ...mode }).url).toBe('/ada');
  });

  it('refuses urlLocales that are not an unprefixed locale and a list of locales', () => {
    // @ts-expect-error supported is missing
    expect(() => resolveRoute(routes, 'about.index', { urlLocales: { unprefixed: 'de' } })).toThrow('urlLocales as { unprefixed: string, supported: string[] }');
    const untyped = resolveRoute as (...args: unknown[]) => unknown;
    for (const urlLocales of [{ unprefixed: 'de' }, { supported: ['en', 'de'] }, { unprefixed: 'de', supported: 'en' }, { unprefixed: 'de', supported: [1] }, 'de', null]) {
      expect(() => untyped(routes, 'about.index', { pageLocale: 'de', urlLocales })).toThrow('urlLocales as { unprefixed: string, supported: string[] }');
    }
  });

  it('builds /de/about as before without the mode, and a route that is not localized as it is', () => {
    expect(resolveRoute(routes, 'about.index', { pageLocale: 'de' }).url).toBe('/de/about');
    expect(resolveRoute(routes, 'people.show', { params: { person: 7 }, pageLocale: 'de', ...mode }).url).toBe('/people/7');
  });
});

describe('matchesRoute', () => {
  const urlLocales = { unprefixed: 'de', supported: ['en', 'de'] };

  it('matches a localized route at its address without a prefix only when the page names the locale that has none', () => {
    expect(matchesRoute(routes['about.index'], '/about')).toBe(false);
    expect(matchesRoute(routes['about.index'], '/about', urlLocales)).toBe(true);
    expect(matchesRoute(routes['about.index'], '/de/about', urlLocales)).toBe(true);
    expect(matchesRoute(routes['about.index'], '/de/about')).toBe(true);
  });

  it('skips a path that starts with a locale, as the server does', () => {
    expect(matchesRoute(routes['profile.show'], '/ada', urlLocales)).toBe(true);
    expect(matchesRoute(routes['profile.show'], '/en', urlLocales)).toBe(false);
    expect(matchesRoute(routes['profile.show'], '/EN', urlLocales)).toBe(false);
    expect(matchesRoute(routes['profile.show'], '/de/EN', urlLocales)).toBe(true);
  });

  it('never gives a route that is not localized a second address', () => {
    expect(matchesRoute(routes['people.show'], '/people/7', urlLocales)).toBe(true);
    expect(matchesRoute({ path: '/:locale/about' }, '/about', urlLocales)).toBe(false);
  });
});

describe('routeEntry', () => {
  it('gives the entry of a route without needing its parameters', () => {
    expect(routeEntry(routes, 'people.show')).toEqual({ method: 'get', path: '/people/:person' });
    expect(routeEntry(routes, 'about.index').localized).toBe(true);
  });

  it('names a route the manifest lacks and a missing manifest', () => {
    expect(() => routeEntry(routes, 'nowhere')).toThrow('[marmeon:C2] Route [nowhere]');
    expect(() => routeEntry(routes, 'toString')).toThrow('[marmeon:C2]');
    expect(() => routeEntry(undefined, 'people.show')).toThrow('[marmeon:C1] Route [people.show]');
  });
});
