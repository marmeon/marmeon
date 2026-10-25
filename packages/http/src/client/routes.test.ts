import { describe, expect, it } from 'vitest';
import { resolveRoute } from './routes.ts';

const routes = {
  'about.index': { method: 'get', path: '/:locale/about', localized: true },
  'about.feature': { method: 'get', path: '/:locale/about/:feature', localized: true },
  'people.show': { method: 'get', path: '/people/:person' },
} as const;

describe('resolveRoute with the locale of the page', () => {
  it('fills it into a localized route that is given none', () => {
    expect(resolveRoute(routes, 'about.index', undefined, undefined, { locale: 'de' }).url).toBe('/de/about');
    expect(resolveRoute(routes, 'about.feature', { feature: 'routes' }, { tab: 'one' }, { locale: 'de-AT' }).url).toBe('/de-AT/about/routes?tab=one');
  });

  it('lets a locale of its own win', () => {
    expect(resolveRoute(routes, 'about.index', { locale: 'en' }, undefined, { locale: 'de' }).url).toBe('/en/about');
  });

  it('leaves a route that is not localized as it is', () => {
    expect(resolveRoute(routes, 'people.show', { person: 7 }, undefined, { locale: 'de' }).url).toBe('/people/7');
  });

  it('still asks for the locale where the page has none', () => {
    expect(() => resolveRoute(routes, 'about.index', undefined, undefined, {})).toThrow('Missing required parameter [locale] for route [about.index].');
    expect(() => resolveRoute(routes, 'about.index')).toThrow('Missing required parameter [locale]');
  });

  it('keeps a locale that is no language inside one path segment of this site', () => {
    for (const locale of ['//evil.example', '/\\evil.example', 'a/b']) {
      const { url } = resolveRoute(routes, 'about.index', { locale }, undefined, { locale: 'de' });
      expect(url).toMatch(/^\/[^/]+\/about$/);
    }
    expect(() => resolveRoute(routes, 'about.index', { locale: '..' }, undefined, { locale: 'de' })).toThrow('a dot segment');
  });
});
