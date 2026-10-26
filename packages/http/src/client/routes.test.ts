import { describe, expect, it } from 'vitest';
import { resolveRoute } from './routes.ts';

const routes = {
  'about.index': { method: 'get', path: '/:locale/about', localized: true },
  'about.feature': { method: 'get', path: '/:locale/about/:feature', localized: true },
  'people.show': { method: 'get', path: '/people/:person' },
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
    expect(() => untyped(routes, 'people.show', undefined, { tab: 'one' })).toThrow('takes { params, query, pageLocale }');
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
