import { createApplication, defineModule } from '@marmeon/core';
import { describe, expect, it } from 'vitest';
import { defineSearch, searchOptions } from './config.ts';
import { SearchSetupError } from './errors.ts';
import { BUILT_IN_LANGUAGES, configFor, configurations, languageMap } from './languages.ts';

const refusal = (run: () => unknown): Error => {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error('nothing was thrown');
};

describe('configFor', () => {
  it('maps the built-in languages to their Snowball configurations, and everything else to simple', () => {
    expect(configFor('de')).toBe('german');
    expect(configFor('en')).toBe('english');
    expect(configFor('nb')).toBe('norwegian');
    expect(configFor('eo')).toBe('simple');
    expect(configFor('zh-Hant-TW')).toBe('simple');
    expect(configFor(null)).toBe('simple');
  });

  it('looks up the exact locale, then its language subtag, then simple', () => {
    const map = languageMap({ 'de-CH': 'swiss_german', pt: 'custom_portuguese' });
    expect(configFor('de-CH', map)).toBe('swiss_german');
    expect(configFor('de-AT', map)).toBe('german');
    expect(configFor('de', map)).toBe('german');
    expect(configFor('pt-BR', map)).toBe('custom_portuguese');
    expect(configFor('ga-IE', map)).toBe('simple');
  });

  it('keys the map by the canonical locale, as documents store theirs', () => {
    const map = languageMap({ 'pt-br': 'brazilian', EN: 'english_custom' });
    expect(configFor('pt-BR', map)).toBe('brazilian');
    expect(configFor('en-US', map)).toBe('english_custom');
  });

  it('maps exactly the documented two-letter codes', () => {
    expect(BUILT_IN_LANGUAGES).toEqual({
      da: 'danish', de: 'german', en: 'english', es: 'spanish', fi: 'finnish', fr: 'french', hu: 'hungarian', it: 'italian', nl: 'dutch',
      no: 'norwegian', nb: 'norwegian', nn: 'norwegian', pt: 'portuguese', ro: 'romanian', ru: 'russian', sv: 'swedish', tr: 'turkish',
    });
  });

  it('gives every configuration of a map once, simple included', () => {
    expect(configurations(languageMap())).toEqual([...new Set([...Object.values(BUILT_IN_LANGUAGES), 'simple'])].sort());
    expect(configurations(languageMap({ ga: 'irish' }))).toContain('irish');
  });
});

describe('languageMap', () => {
  it.each([
    ['a schema', 'pg_catalog.english'],
    ['a capital', 'English'],
    ['a quote', 'english"; drop table x; --'],
    ['a leading digit', '1english'],
    ['an empty name', ''],
    ['64 characters', 'a'.repeat(64)],
    ['no string', 42],
  ])('refuses a configuration name with %s (Q9)', (_, name) => {
    const error = refusal(() => languageMap({ ga: name as string }));
    expect(error).toBeInstanceOf(SearchSetupError);
    expect(error.message).toMatch(/^\[marmeon:Q9\] defineSearch\(\{ languages \}\) maps ga to .*, which is not the name of a text search configuration/);
  });

  it('takes a name of 63 characters with digits and underscores', () => {
    expect(configFor('ga', languageMap({ ga: `_${'a1'.repeat(31)}` }))).toBe(`_${'a1'.repeat(31)}`);
  });

  it('refuses a locale that is no language tag, and one locale spelled twice (Q9)', () => {
    const malformed = refusal(() => languageMap({ 'not a tag': 'simple' }));
    expect(malformed).toBeInstanceOf(SearchSetupError);
    expect(malformed.message).toBe('[marmeon:Q9] defineSearch({ languages }) maps "not a tag", which is not a language tag such as "de" or "de-CH".');
    const twice = refusal(() => languageMap({ 'de-CH': 'german', 'de-ch': 'simple' }));
    expect(twice.message).toBe('[marmeon:Q9] defineSearch({ languages }) maps the locale de-CH twice; keep one spelling.');
  });

  it('refuses a map that is no plain object (Q9)', () => {
    for (const value of [new Map([['de', 'german']]), Object.assign(Object.create({ inherited: 'simple' }), { de: 'german' }), { [Symbol('de')]: 'german' }]) {
      expect(refusal(() => languageMap(value as never))).toBeInstanceOf(SearchSetupError);
    }
  });
});

describe('defineSearch', () => {
  it('refuses a malformed map when it is defined, at the start', () => {
    expect(refusal(() => defineSearch({ languages: { de: 'German' } }))).toBeInstanceOf(SearchSetupError);
  });

  it('is read from the app config, and without one the built-in map applies', async () => {
    const AppSearch = defineSearch({ languages: { 'de-CH': 'simple' } });
    const app = await createApplication({ root: '/', discover: false, config: [AppSearch] }, { env: { LOG_LEVEL: 'silent', NODE_ENV: 'test' } });
    expect(configFor('de-CH', searchOptions(app.container).languages)).toBe('simple');
    const plain = await createApplication({ root: '/', discover: false, modules: [defineModule({ name: 'pages' })] }, { env: { LOG_LEVEL: 'silent', NODE_ENV: 'test' } });
    expect(configFor('de-CH', searchOptions(plain.container).languages)).toBe('german');
  });

  it('refuses two of them in one app (Q9), and counts one listed twice once', async () => {
    const env = { env: { LOG_LEVEL: 'silent', NODE_ENV: 'test' } };
    const app = await createApplication({ root: '/', discover: false, config: [defineSearch({})], modules: [defineModule({ name: 'pages', config: [defineSearch({})] })] }, env);
    const error = refusal(() => searchOptions(app.container));
    expect(error).toBeInstanceOf(SearchSetupError);
    expect(error.message).toBe('[marmeon:Q9] The app has more than one defineSearch(…) in its config; keep one.');
    const AppSearch = defineSearch({ languages: { 'de-CH': 'simple' } });
    const twice = await createApplication({ root: '/', discover: false, config: [AppSearch], modules: [defineModule({ name: 'pages', config: [AppSearch] })] }, env);
    expect(configFor('de-CH', searchOptions(twice.container).languages)).toBe('simple');
  });

  it("reads one from a module's or a provider's config", async () => {
    const env = { env: { LOG_LEVEL: 'silent', NODE_ENV: 'test' } };
    const inModule = await createApplication({ root: '/', discover: false, modules: [defineModule({ name: 'pages', config: [defineSearch({ languages: { 'de-CH': 'simple' } })] })] }, env);
    expect(configFor('de-CH', searchOptions(inModule.container).languages)).toBe('simple');
    class Provider {
      static config = [defineSearch({ languages: { 'de-CH': 'simple' } })];
      register() {}
    }
    const inProvider = await createApplication({ root: '/', discover: false, providers: [Provider] }, env);
    expect(configFor('de-CH', searchOptions(inProvider.container).languages)).toBe('simple');
  });

  it('refuses an option other than languages and options that are no plain object (Q9)', () => {
    const misspelled = refusal(() => defineSearch({ langauges: {} } as never));
    expect(misspelled).toBeInstanceOf(SearchSetupError);
    expect(misspelled.message).toBe('[marmeon:Q9] defineSearch() has no option "langauges"; its one option is languages.');
    expect(refusal(() => defineSearch(null as never))).toBeInstanceOf(SearchSetupError);
    expect(refusal(() => defineSearch(new Map() as never))).toBeInstanceOf(SearchSetupError);
    expect(configFor('de', searchOptionsOf(defineSearch()))).toBe('german');
  });
});

/** The language map a definition resolves to, without an app. */
function searchOptionsOf(definition: ReturnType<typeof defineSearch>): ReadonlyMap<string, string> {
  return definition.resolve({}).languages;
}
