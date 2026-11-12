import { describe, expect, expectTypeOf, it } from 'vitest';
import { PageAlternates, type PageAlternatesSource } from './page-alternates.ts';

const source = (pattern: string, search = ''): PageAlternatesSource => ({ name: 'help.page', pattern, search, locales: ['en', 'de'] });
const page = (pattern = '/:locale/help/:slug', search = ''): PageAlternates => {
  const alternates = new PageAlternates();
  alternates.set({ en: '/en/help/x', de: '/de/help/x', 'x-default': '/help/x' }, source(pattern, search));
  return alternates;
};

describe('PageAlternates.replace()', () => {
  it('builds every version from the route pattern, each with the query', () => {
    const alternates = page('/:locale/help/:slug', '?q=1');
    alternates.replace({ en: { slug: 'getting-started' }, de: { slug: 'erste-schritte' } });
    expect(alternates.paths).toEqual({ en: '/en/help/getting-started?q=1', de: '/de/help/erste-schritte?q=1' });
  });

  it('encodes the parameters, and accepts a locale a value names when it is its key', () => {
    const alternates = page();
    alternates.replace({ en: { slug: 'a b', locale: 'en' } });
    expect(alternates.paths).toEqual({ en: '/en/help/a%20b' });
  });

  it('takes x-default without a locale as the address without a prefix, and with one as that language\'s page', () => {
    const bare = page('/:locale/help/:slug', '?q=1');
    bare.replace({ 'x-default': { slug: 'getting-started' } });
    expect(bare.paths).toEqual({ 'x-default': '/help/getting-started?q=1' });
    const withLocale = page();
    withLocale.replace({ en: { slug: 'getting-started' }, 'x-default': { locale: 'en', slug: 'getting-started' } });
    expect(withLocale.paths).toEqual({ en: '/en/help/getting-started', 'x-default': '/en/help/getting-started' });
  });

  it('leaves out a language without a version, and an empty call leaves no alternates', () => {
    const alternates = page();
    alternates.replace({ de: { slug: 'erste-schritte' } });
    expect(alternates.paths).toEqual({ de: '/de/help/erste-schritte' });
    alternates.replace({});
    expect(alternates.paths).toBeUndefined();
  });

  it('refuses a key that is no supported locale, whatever it holds', () => {
    for (const key of ['fr', 'x"><evil', 'x-Default', '__proto__']) {
      expect(() => page().replace({ [key]: { slug: 'a' } })).toThrow(TypeError);
    }
  });

  it('refuses a value whose locale differs from its language key', () => {
    expect(() => page().replace({ en: { slug: 'a', locale: 'de' } })).toThrow(TypeError);
  });

  it('refuses a locale of x-default that is not supported, and one that is no string', () => {
    expect(() => page().replace({ 'x-default': { locale: 'fr', slug: 'a' } })).toThrow(TypeError);
    expect(() => page().replace({ 'x-default': { locale: '//evil.example', slug: 'a' } })).toThrow(TypeError);
    expect(() => page().replace({ 'x-default': { locale: 5, slug: 'a' } })).toThrow(TypeError);
  });

  it('refuses parameters the route does not match, or that are missing, and changes nothing', () => {
    const alternates = page('/:locale/help/:slug{[a-z-]+}');
    expect(() => alternates.replace({ en: { slug: 'A1' } })).toThrow(TypeError);
    expect(() => alternates.replace({ en: { slug: '..' } })).toThrow(TypeError);
    expect(() => page().replace({ en: { slug: '..%2Fadmin/x' } })).toThrow(TypeError);
    expect(() => alternates.replace({ en: {} })).toThrow(TypeError);
    expect(() => alternates.replace({ en: { slug: 'ok' }, de: { slug: 'NO' } })).toThrow(TypeError);
    expect(alternates.paths).toEqual({ en: '/en/help/x', de: '/de/help/x', 'x-default': '/help/x' });
  });

  it('refuses a call on a page that is not of a localized route', () => {
    expect(() => new PageAlternates().replace({ en: { slug: 'a' } })).toThrow(TypeError);
    expect(() => new PageAlternates().none()).toThrow(TypeError);
  });
});

describe('PageAlternates.none()', () => {
  it('leaves the page without other versions', () => {
    const alternates = page();
    alternates.none();
    expect(alternates.paths).toBeUndefined();
  });
});

describe('the types of PageAlternates', () => {
  it('takes parameter objects of strings and numbers by key', () => {
    const alternates = new PageAlternates();
    expectTypeOf(alternates.replace).parameter(0).toEqualTypeOf<Readonly<Record<string, Readonly<Record<string, string | number>>>>>();
    // @ts-expect-error a version is parameters, not a path
    expect(() => alternates.replace({ en: '/en/about' })).toThrow();
    // @ts-expect-error a parameter is a string or a number
    expect(() => alternates.replace({ en: { slug: true } })).toThrow();
  });
});
