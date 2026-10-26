import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { formatMessage, parseMessage } from './format.ts';
import { langFileOf } from './loader.ts';
import { negotiateLocale, supportedLocale } from './locale.ts';
import { Catalog, createMessageLoader } from './messages.ts';

describe('formatMessage (ICU subset)', () => {
  it('fills placeholders, formats numbers and dates for the locale', () => {
    expect(formatMessage('Hello {name}', { name: 'Ada' })).toBe('Hello Ada');
    expect(formatMessage('{n} visits', { n: 1234.5 }, 'en')).toBe('1,234.5 visits');
    expect(formatMessage('{n} Besuche', { n: 1234.5 }, 'de')).toBe('1.234,5 Besuche');
    expect(formatMessage('{n, number, percent}', { n: 0.25 }, 'de')).toBe('25\u00a0%'); // a non-breaking space
    expect(formatMessage('{n, number, integer}', { n: 2.7 }, 'en')).toBe('3');
    expect(formatMessage('{d, date, long}', { d: '2026-10-01T12:00:00Z' }, 'de')).toBe('1. Oktober 2026');
    expect(formatMessage('{d, date, short}', { d: new Date('2026-10-01T12:00:00Z') }, 'en')).toBe('10/1/26');
  });

  it('plural: exact matches, categories of Intl.PluralRules, # as the number', () => {
    const cart = '{count, plural, =0 {empty} one {# item} other {# items}}';
    expect(formatMessage(cart, { count: 0 })).toBe('empty');
    expect(formatMessage(cart, { count: 1 })).toBe('1 item');
    expect(formatMessage(cart, { count: 1000 })).toBe('1,000 items');
    // Polish has more categories than English — the rules of the locale decide.
    const pl = '{n, plural, one {# plik} few {# pliki} many {# plików} other {# pliku}}';
    expect([1, 2, 5, 22, 1.5].map((n) => formatMessage(pl, { n }, 'pl'))).toEqual(['1 plik', '2 pliki', '5 plików', '22 pliki', '1,5 pliku']);
    expect(formatMessage('{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}', { n: 23 })).toBe('23rd');
  });

  it('select, nested placeholders, # inside a select inside a plural', () => {
    const message = '{kind, select, link {Added {label}} other {Joined}}';
    expect(formatMessage(message, { kind: 'link', label: 'Blog' })).toBe('Added Blog');
    expect(formatMessage(message, { kind: 'x' })).toBe('Joined');
    expect(formatMessage('{n, plural, one {{who, select, me {# by me} other {# by {who}}}} other {#}}', { n: 1, who: 'Ada' })).toBe('1 by Ada');
  });

  it('quoting as in ICU; a missing value stays visible; the result is text', () => {
    expect(formatMessage("It's '{name}' and '#'", { name: 'x' })).toBe("It's {name} and '#'");
    expect(formatMessage("'{'{n}'}' ''", { n: 1 })).toBe("{1} '");
    expect(formatMessage('Hello {name}', {})).toBe('Hello {name}');
    expect(formatMessage('Hi {name}', { name: '<script>alert(1)</script>' })).toBe('Hi <script>alert(1)</script>');
  });

  it('rejects malformed messages with the position', () => {
    expect(() => parseMessage('{count, plural, one {#}}')).toThrow(/needs an "other" branch/);
    expect(() => parseMessage('Hello {name')).toThrow(/Unclosed placeholder \{name/);
    expect(() => parseMessage('Hello {name')).toThrow('[marmeon:S5] Unclosed placeholder');
    expect(() => parseMessage('{n, money}')).toThrow(/Unknown placeholder type "money"/);
    expect(() => parseMessage('a } b')).toThrow(/Unexpected "}" at position 2/);
    expect(() => parseMessage('{n, plural, offset:1 other {#}}')).toThrow(/offset/);
  });
});

describe('locales', () => {
  const supported = ['en', 'de', 'pt-BR'];

  it('negotiates Accept-Language by quality and order, with region and language fallbacks', () => {
    expect(negotiateLocale('de-AT,de;q=0.9,en;q=0.8', supported)).toBe('de');
    expect(negotiateLocale('fr, en;q=0.5, de;q=0.7', supported)).toBe('de');
    expect(negotiateLocale('pt', supported)).toBe('pt-BR');
    expect(negotiateLocale('PT-br', supported)).toBe('pt-BR');
    expect(negotiateLocale('fr, *;q=0.1', supported)).toBeUndefined();
    expect(negotiateLocale('de;q=0, en', supported)).toBe('en');
  });

  it('never turns a foreign value into a locale: only supported ones, in their spelling', () => {
    for (const value of ['../../etc/passwd', 'de"><script>', 'de/../../x', '__proto__', 'constructor', 'de\nSet-Cookie: x', 'x'.repeat(200), '', undefined, 42, {}]) {
      expect(supportedLocale(value, supported)).toBeUndefined();
    }
    expect(negotiateLocale('../../etc/passwd, de"><script>;q=0.9, en;q=0.1', supported)).toBe('en');
    expect(supportedLocale('DE', supported)).toBe('de');
  });
});

describe('Catalog', () => {
  const catalog = new Catalog({ fallback: 'en' })
    .add('en', 'shop', { greeting: 'Hello {name}', only: { english: 'Only in English: {count, plural, one {# item} other {# items}}' } })
    .add('de', 'shop', { greeting: 'Hallo {name}' });

  it('looks up a key in the locale, its language, then the fallback locale — formatted in the locale it was found in', () => {
    expect(catalog.text('de', 'shop.greeting', { name: 'Ada' })).toBe('Hallo Ada');
    expect(catalog.text('de-AT', 'shop.greeting', { name: 'Ada' })).toBe('Hallo Ada');
    expect(catalog.text('de', 'shop.only.english', { count: 1000 })).toBe('Only in English: 1,000 items');
    expect(catalog.text('de', 'shop.missing')).toBe('shop.missing');
    expect(catalog.text('de', 'shop.missing', { n: 2 }, 'Fallback {n}')).toBe('Fallback 2');
    expect(catalog.has('de', 'shop.only.english')).toBe(true);
    expect(catalog.has('de', 'shop.nope')).toBe(false);
  });

  it('fails when a file is malformed — with the key and the file', () => {
    expect(() => new Catalog({ fallback: 'en' }).add('de', 'shop', { a: { b: 'Hallo {name' } }, 'modules/shop/lang/de.ts')).toThrow(
      '[marmeon:S5] Message shop.a.b in modules/shop/lang/de.ts is malformed: Unclosed placeholder {name at position 11 of "Hallo {name"',
    );
    expect(() => new Catalog({ fallback: 'en' }).add('de', 'shop', ['x'])).toThrow(/must export an object of messages/);
    expect(() => new Catalog({ fallback: 'en' }).add('de', 'shop', { 'a.b': 'x' })).toThrow(/may not contain dots/);
  });

  it('formats numbers, dates and relative times', () => {
    const format = catalog.formatter('de');
    expect(format.number(1234.5)).toBe('1.234,5');
    expect(format.relative('2026-10-01T11:57:00Z', '2026-10-01T12:00:00Z')).toBe('vor 3 Minuten');
    expect(format.relative('2026-09-30T12:00:00Z', '2026-10-01T12:00:00Z')).toBe('gestern');
    expect(catalog.formatter('en').relative('2026-10-03T12:00:00Z', '2026-10-01T12:00:00Z')).toBe('in 2 days');
    expect(format.date('2026-10-01T12:00:00Z', { dateStyle: 'medium', timeZone: 'UTC' })).toBe('01.10.2026');
  });
});

describe('createMessageLoader (virtual:marmeon/lang)', () => {
  const files = () => {
    const load = (messages: object) => vi.fn(async () => ({ default: messages }));
    return {
      '/modules/shop/lang/en.ts': load({ greeting: 'Hello' }),
      '/modules/shop/lang/de.ts': load({ greeting: 'Hallo' }),
      '/modules/lab/lang/en.ts': load({ title: 'Lab' }),
      '/lang/en.ts': load({ name: 'App' }),
      '/lang/de.ts': load({ name: 'Anwendung' }),
      '/modules/shop/views/Show.tsx': vi.fn(),
    };
  };

  it('reads namespace and locale from the path', () => {
    expect(langFileOf('/modules/user-profile/lang/de-AT.ts')).toEqual({ namespace: 'user-profile', locale: 'de-AT' });
    expect(langFileOf('/lang/en.ts')).toEqual({ namespace: 'app', locale: 'en' });
    expect(langFileOf('/modules/shop/views/en.ts')).toBeUndefined();
    expect(langFileOf('/modules/shop/lang/..%2f.ts')).toBeUndefined();
  });

  it('loads only the active locale — and the fallback only for namespaces without it', async () => {
    const lang = files();
    const catalog = await createMessageLoader(lang, { fallback: 'en' }).load('de');
    expect(lang['/modules/shop/lang/de.ts']).toHaveBeenCalledOnce();
    expect(lang['/lang/de.ts']).toHaveBeenCalledOnce();
    expect(lang['/modules/lab/lang/en.ts']).toHaveBeenCalledOnce(); // lab has no de.ts
    expect(lang['/modules/shop/lang/en.ts']).not.toHaveBeenCalled();
    expect(lang['/lang/en.ts']).not.toHaveBeenCalled();
    expect(catalog.text('de', 'shop.greeting')).toBe('Hallo');
    expect(catalog.text('de', 'app.name')).toBe('Anwendung');
    expect(catalog.text('de', 'lab.title')).toBe('Lab');
  });

  it('loads a locale once; a locale that is no language tag loads the fallback, never a path', async () => {
    const lang = files();
    const loader = createMessageLoader(lang, { fallback: 'en' });
    expect(await loader.load('de')).toBe(await loader.load('de'));
    expect(lang['/modules/shop/lang/de.ts']).toHaveBeenCalledOnce();
    const evil = await loader.load('../../../etc/passwd');
    expect(evil.text('en', 'shop.greeting')).toBe('Hello');
    expect(Object.values(lang).flatMap((load) => load.mock.calls)).toHaveLength(6); // de: 3 files; the fallback (en): 3 more
  });

  it("falls back to the locale the server names (the page's fallbackLocale) — configured once, on the server", async () => {
    const lang = { ...files(), '/modules/lab/lang/de.ts': vi.fn(async () => ({ default: { title: 'Labor' } })) };
    const loader = createMessageLoader(lang); // no fallback of its own
    // A French page of an app whose APP_FALLBACK_LOCALE is de: namespaces without fr.ts come from de, not en.
    const french = await loader.load('fr', { fallback: 'de' });
    expect(french.text('fr', 'lab.title')).toBe('Labor');
    expect(french.text('fr', 'shop.greeting')).toBe('Hallo');
    expect(lang['/modules/lab/lang/en.ts']).not.toHaveBeenCalled();
    // Another fallback is another set of messages; a fallback that is no language tag is never used.
    expect((await loader.load('fr', { fallback: 'en' })).text('fr', 'lab.title')).toBe('Lab');
    expect((await loader.load('fr', { fallback: '../../x' })).text('fr', 'lab.title')).toBe('Lab');
  });
});

describe('the browser entry', () => {
  it('reaches no server code: no node: import and no @marmeon/core/internal', () => {
    const seen = new Set<string>();
    const offenders: string[] = [];
    const walk = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const [, specifier] of text.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|^import\s+)['"]([^'"]+)['"]/gm)) {
        if (specifier!.startsWith('node:') || specifier!.includes('@marmeon/core/internal')) offenders.push(`${file}: ${specifier}`);
        else if (specifier!.startsWith('.')) walk(fileURLToPath(new URL(specifier!, `file://${file}`)));
      }
    };
    walk(fileURLToPath(new URL('./messages.ts', import.meta.url)));
    expect(seen.size).toBeGreaterThan(2);
    expect(offenders).toEqual([]);
  });
});
