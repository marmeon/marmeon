import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  cleanText,
  excerptSegments,
  fts5Match,
  MARK_END,
  MARK_START,
  MAX_TERM_LENGTH,
  MAX_TOKEN_LENGTH,
  MAX_TOKENS,
  meilisearchFilter,
  meilisearchFilterValue,
  postgresPrefixQuery,
  searchText,
  tokens,
} from './terms.ts';
import { HOSTILE } from './test-helpers/hostile-terms.ts';

const NUL = String.fromCharCode(0);
const COMBINING_ACUTE = String.fromCharCode(0x0301);
const LONE_SURROGATE = String.fromCharCode(0xd800);
/** A list of `length` holes: no entries at all, unlike a list of undefined. */
const holes = (length: number): string[] => Object.assign([], { length });
const codePoints = (text: string) => [...text].length;

// No character with a meaning in tsquery, FTS5 or a Meilisearch filter may come from the input.
const SYNTAX = /["':()&|!*\\<>^+]/;

describe('tokens()', () => {
  it.each(HOSTILE)('keeps only letters, marks and numbers from %s', (_, input) => {
    const found = tokens(input);
    expect(found.length).toBeLessThanOrEqual(MAX_TOKENS);
    for (const token of found) {
      expect(token).toMatch(/^[\p{L}\p{N}][\p{L}\p{M}\p{N}]*$/u);
      expect(token).not.toMatch(SYNTAX);
      expect(codePoints(token)).toBeLessThanOrEqual(MAX_TOKEN_LENGTH);
    }
  });

  it('splits at everything that is no letter, mark or number', () => {
    expect(tokens('foo" OR (bar')).toEqual(['foo', 'OR', 'bar']);
    expect(tokens('a:see')).toEqual(['a', 'see']);
    expect(tokens('NEAR(x y)')).toEqual(['NEAR', 'x', 'y']);
    expect(tokens("'):*&!<->\\")).toEqual([]);
    expect(tokens('"""')).toEqual([]);
    expect(tokens('*')).toEqual([]);
    expect(tokens('')).toEqual([]);
  });

  it('finds no token in a term of NUL characters and markers, and removes them without splitting the token', () => {
    expect(tokens(`${NUL}${MARK_START}${MARK_END}`)).toEqual([]);
    expect(tokens(`ab${MARK_START}cd`)).toEqual(['abcd']);
    expect(tokens(`ab${NUL}cd`)).toEqual(['abcd']);
  });

  it('keeps stop words: whether a word is one is the engine’s call', () => {
    expect(tokens('the and of')).toEqual(['the', 'and', 'of']);
  });

  it('normalizes with NFKC, so compatibility forms and decomposed accents become one token', () => {
    expect(tokens('ﬁle Ｆｕｌｌ')).toEqual(['file', 'Full']);
    expect(tokens(`cafe${COMBINING_ACUTE}`)).toEqual(['café']);
  });

  it('turns fullwidth operators into syntax first and tokenizes after, so they split like their ASCII forms', () => {
    expect(tokens('＂ａ＂ ＆ ｂ＊ ｜ （ｃ）')).toEqual(['a', 'b', 'c']);
  });

  it('starts no token with a combining mark', () => {
    expect(tokens(`${String.fromCharCode(0x0302)}abc`)).toEqual(['abc']);
    expect(tokens(` ${String.fromCharCode(0x0302)} `)).toEqual([]);
  });

  it('splits at a lone surrogate', () => {
    expect(tokens(`ab${LONE_SURROGATE}cd`)).toEqual(['ab', 'cd']);
  });

  it('keeps a combining mark that NFKC cannot compose inside its token', () => {
    const q = `q${COMBINING_ACUTE}`;
    expect(tokens(`${q}x`)).toEqual([`${q}x`]);
  });

  it('reads scripts beyond Latin and drops emoji', () => {
    expect(tokens('مرحبا بالعالم')).toEqual(['مرحبا', 'بالعالم']);
    expect(tokens('全文搜索 测试')).toEqual(['全文搜索', '测试']);
    expect(tokens('🔍 search 👩‍💻 code')).toEqual(['search', 'code']);
  });

  it('returns at most 16 tokens, the first ones', () => {
    const found = tokens(Array.from({ length: 40 }, (_, i) => `word${i}`).join(' '));
    expect(found).toHaveLength(MAX_TOKENS);
    expect(found[0]).toBe('word0');
    expect(found.at(-1)).toBe('word15');
  });

  it('cuts a token at 100 characters, counted in code points', () => {
    expect(tokens('x'.repeat(10_000))).toEqual(['x'.repeat(MAX_TOKEN_LENGTH)]);
    const han = '𠀀'.repeat(150); // outside the BMP: two UTF-16 units each
    expect(tokens(han)).toEqual(['𠀀'.repeat(MAX_TOKEN_LENGTH)]);
  });

  it('reads only the first 256 characters of a term', () => {
    // `after` lies behind character 256; without the cut it would be the second token.
    expect(tokens(`${'x'.repeat(MAX_TERM_LENGTH)} after`)).toEqual(['x'.repeat(MAX_TOKEN_LENGTH)]);
    expect(tokens(`${'x'.repeat(MAX_TERM_LENGTH - 6)} after`)).toEqual(['x'.repeat(MAX_TOKEN_LENGTH), 'after']);
  });

  it('returns a frozen list', () => {
    expect(Object.isFrozen(tokens('a b'))).toBe(true);
  });
});

describe('searchText()', () => {
  it('normalizes with NFKC and cuts at 256 code points', () => {
    expect(searchText('ﬁle')).toBe('file');
    expect(codePoints(searchText('x'.repeat(10_000)))).toBe(MAX_TERM_LENGTH);
    expect(codePoints(searchText('𠀀'.repeat(300)))).toBe(MAX_TERM_LENGTH);
  });

  it('cuts again after NFKC expanded the term', () => {
    // U+FDFA expands to 18 characters under NFKC.
    const expanded = searchText(String.fromCharCode(0xfdfa).repeat(100));
    expect(codePoints(expanded)).toBe(MAX_TERM_LENGTH);
  });

  it('normalizes no more than the first 256 characters of a long input', () => {
    const spy = vi.spyOn(String.prototype, 'normalize');
    try {
      searchText('x'.repeat(10_000));
      const receivers = spy.mock.contexts.map((context) => String(context));
      expect(receivers.length).toBeGreaterThan(0);
      for (const receiver of receivers) expect(codePoints(receiver)).toBeLessThanOrEqual(MAX_TERM_LENGTH);
    } finally {
      spy.mockRestore();
    }
  });

  it('drops NUL and the markers, and keeps everything else for websearch_to_tsquery', () => {
    expect(searchText(`a${NUL}b${MARK_START}c${MARK_END}`)).toBe('abc');
    expect(searchText('"foo bar" -baz or qux')).toBe('"foo bar" -baz or qux');
  });

  it('replaces a lone surrogate, which a JSON parser may refuse', () => {
    expect(searchText(`a${LONE_SURROGATE}b`)).toBe(`a${String.fromCharCode(0xfffd)}b`);
    expect(searchText(`a${LONE_SURROGATE}b`).isWellFormed()).toBe(true);
  });
});

describe('postgresPrefixQuery()', () => {
  it('requires every token and makes the last a prefix', () => {
    expect(postgresPrefixQuery(['häus'])).toBe('häus:*');
    expect(postgresPrefixQuery(['foo', 'bar', 'baz'])).toBe('foo & bar & baz:*');
  });

  it.each(HOSTILE)('holds no operator from the input for %s', (_, input) => {
    const found = tokens(input);
    if (found.length === 0) {
      expect(() => postgresPrefixQuery(found)).toThrow(TypeError);
      return;
    }
    const query = postgresPrefixQuery(found);
    // The only operators are the ones the function writes: ` & ` between tokens and `:*` at the end.
    const body = query.slice(0, -2).split(' & ');
    expect(query.endsWith(':*')).toBe(true);
    expect(body).toEqual(found);
    for (const token of body) expect(token).not.toMatch(SYNTAX);
  });

  it('refuses an empty list: a term without tokens searches nothing', () => {
    expect(() => postgresPrefixQuery([])).toThrow(TypeError);
  });

  it('refuses more tokens or longer ones than tokens() returns', () => {
    expect(postgresPrefixQuery(Array.from({ length: MAX_TOKENS }, () => 'x'))).toMatch(/:\*$/);
    expect(() => postgresPrefixQuery(Array.from({ length: MAX_TOKENS + 1 }, () => 'x'))).toThrow(/at most 16/);
    expect(postgresPrefixQuery(['𠀀'.repeat(MAX_TOKEN_LENGTH)])).toBe(`${'𠀀'.repeat(MAX_TOKEN_LENGTH)}:*`);
    expect(() => postgresPrefixQuery(['x'.repeat(MAX_TOKEN_LENGTH + 1)])).toThrow(TypeError);
  });

  it('builds from the tokens it checked, even when the list reads differently the second time', () => {
    let reads = 0;
    const shifty = Object.defineProperty(['x'], 0, { get: () => (reads++ === 0 ? 'ok' : 'a | b') }) as string[];
    expect(postgresPrefixQuery(shifty)).toBe('ok:*');
    reads = 0;
    expect(fts5Match(shifty, false)).toBe('"ok"');
  });

  it('refuses a string that is not a token', () => {
    expect(() => postgresPrefixQuery(['foo', 'bar:*'])).toThrow(TypeError);
    expect(() => postgresPrefixQuery(['a | b'])).toThrow(TypeError);
    expect(() => postgresPrefixQuery([''])).toThrow(TypeError);
  });
});

describe('fts5Match()', () => {
  it('quotes every token, with a prefix star after the last one only when asked', () => {
    expect(fts5Match(['foo', 'bar'], false)).toBe('"foo" "bar"');
    expect(fts5Match(['foo', 'bar'], true)).toBe('"foo" "bar"*');
    expect(fts5Match(['NEAR'], false)).toBe('"NEAR"');
  });

  it.each(HOSTILE)('holds only quoted tokens for %s', (_, input) => {
    const found = tokens(input);
    if (found.length === 0) {
      expect(() => fts5Match(found, false)).toThrow(TypeError);
      return;
    }
    for (const prefix of [false, true]) {
      const match = fts5Match(found, prefix);
      const body = prefix ? match.slice(0, -1) : match;
      expect(body).toBe(found.map((token) => `"${token}"`).join(' '));
      // Exactly two quotes per token: none can come from the input.
      expect(match.split('"').length - 1).toBe(found.length * 2);
      expect(body.replaceAll('"', '')).not.toMatch(SYNTAX);
    }
  });

  it('refuses an empty list and a string that is not a token', () => {
    expect(() => fts5Match([], false)).toThrow(TypeError);
    expect(() => fts5Match(['a" OR "b'], false)).toThrow(TypeError);
    expect(() => fts5Match(['a:b'], true)).toThrow(TypeError);
    expect(() => fts5Match(Array.from({ length: MAX_TOKENS + 1 }, () => 'x'), true)).toThrow(TypeError);
    expect(() => fts5Match(['x'.repeat(MAX_TOKEN_LENGTH + 1)], false)).toThrow(TypeError);
    expect(() => fts5Match(holes(1), false)).toThrow(TypeError);
  });
});

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const h = (value: string | number | boolean) => meilisearchFilterValue(value);
// Every value in a filter, quoted: only these may stand between the quotes.
const filterValues = (filter: string) => [...filter.matchAll(/"([^"]*)"/g)].map((found) => found[1]);

describe('meilisearchFilterValue()', () => {
  it('is the hex SHA-256 of the type tag and the value', () => {
    expect(h('alice')).toBe(sha256('s:"alice"'));
    expect(h(7)).toBe(sha256('n:7'));
    expect(h(true)).toBe(sha256('b:true'));
    expect(h(false)).toBe(sha256('b:false'));
  });

  it('keeps apart what Meilisearch would fold together: case, spaces, fullwidth and decomposed forms', () => {
    const values = ['alice', 'ALICE', 'Alice', 'alice ', ' alice', 'ａｌｉｃｅ', 'café', `cafe${COMBINING_ACUTE}`];
    expect(new Set(values.map(h)).size).toBe(values.length);
  });

  it('keeps types apart: a string that reads as a number or a boolean is no number or boolean', () => {
    const values = [h(7), h('7'), h('07'), h('7.0'), h('7e0'), h(true), h('true'), h(false), h('false'), h(0), h('')];
    expect(new Set(values).size).toBe(values.length);
  });

  it('hashes numbers of any size, which Meilisearch could not read written out', () => {
    expect(h(1e21)).toMatch(/^[0-9a-f]{64}$/);
    expect(h(1e21)).not.toBe(h(1e20));
    expect(h(Number.MAX_VALUE)).toBe(sha256(`n:${String(Number.MAX_VALUE)}`));
  });

  it('stores both zeros alike, as they compare equal', () => {
    expect(h(-0)).toBe(h(0));
  });

  it('keeps a lone surrogate apart from the replacement character', () => {
    expect(h(`a${LONE_SURROGATE}`)).not.toBe(h(`a${String.fromCharCode(0xfffd)}`));
  });

  it('refuses what is no string, finite number or boolean, naming the filter when given', () => {
    const unsafe = (value: unknown) => value as string;
    expect(() => meilisearchFilterValue(unsafe(undefined))).toThrow(/^A search filter value must be .* not undefined/);
    expect(() => meilisearchFilterValue(unsafe(null), 'tenant')).toThrow(/^The search filter "tenant" must be .* not null/);
    expect(() => meilisearchFilterValue(Number.NaN)).toThrow(/finite/);
    expect(() => meilisearchFilterValue(unsafe(1n))).toThrow(TypeError);
  });
});

describe('meilisearchFilter()', () => {
  it('ANDs equality and one-of filters on the stored f_ attributes, with the locale last', () => {
    expect(meilisearchFilter({ kind: 'page', audience: ['staff', 'public'] }, 'de')).toBe(
      `f_kind = "${h('page')}" AND f_audience IN ["${h('staff')}", "${h('public')}"] AND locale = "de"`,
    );
  });

  it('compares numbers and booleans by their hash too', () => {
    expect(meilisearchFilter({ tenant: 42, draft: false, ids: [1, 2.5, -3] })).toBe(
      `f_tenant = "${h(42)}" AND f_draft = "${h(false)}" AND f_ids IN ["${h(1)}", "${h(2.5)}", "${h(-3)}"]`,
    );
  });

  it('holds only hashes as values, whatever the input', () => {
    const filter = meilisearchFilter({ a: 'x" OR f_tenant = "y', b: 'x\\', c: ['ALICE ', 1e21, true], d: `${NUL}${MARK_START}` });
    const values = filterValues(filter);
    expect(values).toHaveLength(6);
    for (const value of values) expect(value).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps an injected expression out of the filter', () => {
    expect(meilisearchFilter({ tenant: 'x" OR f_tenant = "y' })).toBe(`f_tenant = "${h('x" OR f_tenant = "y')}"`);
  });

  it('is empty without filters and locale', () => {
    expect(meilisearchFilter({})).toBe('');
    expect(meilisearchFilter({}, 'en')).toBe('locale = "en"');
  });

  it('escapes the locale: a quote and a backslash stay inside one quoted string', () => {
    const filter = meilisearchFilter({}, 'de" OR locale = "en');
    expect(filter).toBe('locale = "de\\" OR locale = \\"en"');
    expect(filter.match(/(?<!\\)"/g)).toHaveLength(2);
    expect(meilisearchFilter({}, 'de\\')).toBe('locale = "de\\\\"');
  });

  it.each(['Tenant', '1tenant', 'f-tenant', 'tenant = 1 OR x', '', 'a'.repeat(65), 'tenant\n'])(
    'refuses the filter name %j',
    (name) => {
      expect(() => meilisearchFilter({ [name]: 'x' })).toThrow(TypeError);
    },
  );

  it('accepts a name of 64 characters', () => {
    expect(meilisearchFilter({ ['a'.repeat(64)]: 1 })).toBe(`f_${'a'.repeat(64)} = "${h(1)}"`);
  });

  it('refuses undefined and null instead of dropping the filter', () => {
    const unsafe = (value: unknown) => ({ tenant: value }) as Record<string, string>;
    expect(() => meilisearchFilter(unsafe(undefined))).toThrow(/tenant.*not undefined/);
    expect(() => meilisearchFilter(unsafe(null))).toThrow(/tenant.*not null/);
    expect(() => meilisearchFilter(unsafe([1, null]))).toThrow(TypeError);
  });

  it('refuses an empty list', () => {
    expect(() => meilisearchFilter({ tenant: [] })).toThrow(/empty list/);
  });

  it('refuses a list with holes instead of skipping them', () => {
    expect(() => meilisearchFilter({ tenant: holes(2) })).toThrow(/tenant.*not undefined/);
    const list = ['a', 'b', 'c'];
    delete list[1];
    expect(() => meilisearchFilter({ tenant: list })).toThrow(/tenant.*not undefined/);
  });

  it('refuses filters that are not a plain object instead of reading none of them', () => {
    const unsafe = (value: unknown) => value as Record<string, string>;
    expect(() => meilisearchFilter(unsafe(Object.create({ tenant: 'a' })))).toThrow(/plain object/);
    expect(() => meilisearchFilter(unsafe(new Map([['tenant', 'a']])))).toThrow(/plain object/);
    expect(() => meilisearchFilter(unsafe(42))).toThrow(/plain object/);
    expect(() => meilisearchFilter(unsafe(null))).toThrow(/plain object/);
    const hidden = Object.defineProperty({ kind: 'page' }, 'tenant', { value: 'acme', enumerable: false });
    expect(() => meilisearchFilter(hidden)).toThrow(/plain object/);
    expect(() => meilisearchFilter(unsafe({ kind: 'page', [Symbol('tenant')]: 'acme' }))).toThrow(/plain object/);
    expect(meilisearchFilter(unsafe(Object.assign(Object.create(null), { tenant: 'a' })))).toBe(`f_tenant = "${h('a')}"`);
  });

  it('refuses a locale that is empty, no string or not well-formed', () => {
    expect(() => meilisearchFilter({}, '')).toThrow(/locale/);
    expect(() => meilisearchFilter({}, `de${LONE_SURROGATE}`)).toThrow(/locale/);
    expect(() => meilisearchFilter({}, null as unknown as string)).toThrow(/locale/);
    expect(() => meilisearchFilter({}, 7 as unknown as string)).toThrow(/locale/);
  });

  it('refuses a number that is not finite', () => {
    expect(() => meilisearchFilter({ score: Number.NaN })).toThrow(/finite/);
    expect(() => meilisearchFilter({ score: Number.POSITIVE_INFINITY })).toThrow(/finite/);
    expect(() => meilisearchFilter({ score: [1, Number.NEGATIVE_INFINITY] })).toThrow(/finite/);
  });

  it('refuses objects, nested lists and bigints', () => {
    const unsafe = (value: unknown) => ({ tenant: value }) as Record<string, string>;
    expect(() => meilisearchFilter(unsafe({ toString: () => 'x' }))).toThrow(TypeError);
    expect(() => meilisearchFilter(unsafe([['a']]))).toThrow(/tenant.*not a list/);
    expect(() => meilisearchFilter(unsafe(1n))).toThrow(TypeError);
  });
});

describe('excerptSegments()', () => {
  it('turns markers into segments', () => {
    expect(excerptSegments(`the ${MARK_START}quick${MARK_END} brown ${MARK_START}fox${MARK_END}`)).toEqual([
      { text: 'the ', match: false },
      { text: 'quick', match: true },
      { text: ' brown ', match: false },
      { text: 'fox', match: true },
    ]);
  });

  it('returns text without markers as one segment, and nothing for empty text', () => {
    expect(excerptSegments('<b>no</b> markers')).toEqual([{ text: '<b>no</b> markers', match: false }]);
    expect(excerptSegments('')).toEqual([]);
  });

  it('drops an end without a start, marks the rest after an open start and joins neighbouring runs', () => {
    expect(excerptSegments(`a${MARK_END}b`)).toEqual([{ text: 'ab', match: false }]);
    expect(excerptSegments(`a${MARK_START}b`)).toEqual([
      { text: 'a', match: false },
      { text: 'b', match: true },
    ]);
    expect(excerptSegments(`${MARK_START}a${MARK_END}${MARK_START}b${MARK_END}`)).toEqual([{ text: 'ab', match: true }]);
    expect(excerptSegments(`${MARK_START}${MARK_END}x`)).toEqual([{ text: 'x', match: false }]);
  });

  it('keeps characters outside the BMP whole', () => {
    expect(excerptSegments(`${MARK_START}𠀀${MARK_END}🔍`)).toEqual([
      { text: '𠀀', match: true },
      { text: '🔍', match: false },
    ]);
  });

  it('returns frozen segments', () => {
    const segments = excerptSegments(`a${MARK_START}b`);
    expect(Object.isFrozen(segments)).toBe(true);
    expect(Object.isFrozen(segments[0])).toBe(true);
  });
});

describe('cleanText()', () => {
  it('removes NUL and both markers and keeps the rest', () => {
    expect(cleanText(`a${NUL}b${MARK_START}c${MARK_END}d`)).toBe('abcd');
    expect(cleanText(`a${LONE_SURROGATE}b`)).toBe(`a${String.fromCharCode(0xfffd)}b`);
    expect(cleanText('plain <b>text</b> 🔍')).toBe('plain <b>text</b> 🔍');
  });

  it('leaves no marker an excerpt could take for a highlight', () => {
    const forged = cleanText(`${MARK_START}admin${MARK_END}`);
    expect(excerptSegments(forged)).toEqual([{ text: 'admin', match: false }]);
  });

  it('marks are the private-use characters 0xE000 and 0xE001', () => {
    expect(MARK_START.codePointAt(0)).toBe(0xe000);
    expect(MARK_END.codePointAt(0)).toBe(0xe001);
  });
});
