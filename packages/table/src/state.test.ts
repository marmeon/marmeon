import { parseQuery } from '@marmeon/router';
import { rules as r } from '@marmeon/validation';
import { describe, expect, it } from 'vitest';
import './__fixtures__/schema.ts';
import { FeedTable, MembersTable } from './__fixtures__/app.ts';
import { MemberPolicy } from './__fixtures__/policies.ts';
import { column, defineTable, filter } from './index.ts';
import { parseState, queryKeys, stateQuery, TableQueryError } from './state.ts';
import { parseKey } from './tables.ts';

const members = MembersTable.definition;
const search = (query: string) => new URLSearchParams(query);

describe('the table\'s state in the URL', () => {
  it('parses what the table allows — defaults filled in', () => {
    expect(parseState(members, search(''))).toEqual({ sort: { column: 'name', direction: 'asc' }, page: 1, perPage: 2, cursor: undefined, search: '', filters: {} });
    expect(parseState(members, search('sort=-joined&page=3&per_page=10&search=%20ada%20&filter[role]=admin&filter[joined]=..2026-01-31&tab=x'))).toEqual({
      sort: { column: 'joined', direction: 'desc' },
      page: 3,
      perPage: 10,
      cursor: undefined,
      search: 'ada',
      filters: { role: 'admin', joined: '..2026-01-31' },
    });
  });

  it.each(['sort=nope', 'sort=-role', 'per_page=3', 'page=1.5', 'page=-1', 'filter[x]=1', 'filter[role]=', 'filter[joined]=..', 'filter[joined]=2026-02-30..', 'cursor=abc', 'sort=name&sort=name'])(
    'refuses %s with a TableQueryError (400)',
    (query) => {
      expect(() => parseState(members, search(query))).toThrow(TableQueryError);
    },
  );

  it('prefixes its keys for a second table on the page', () => {
    expect(queryKeys(FeedTable.definition)).toMatchObject({ sort: 'feed_sort', cursor: 'feed_cursor', perPage: 'feed_per_page' });
    expect(parseState(FeedTable.definition, search('sort=nope&page=9&feed_sort=name')).sort).toEqual({ column: 'name', direction: 'asc' });
    expect(() => parseState(FeedTable.definition, search('feed_page=2'))).toThrow(TableQueryError);
  });

  it('writes back only what differs from the defaults — never the page or a cursor', () => {
    const state = parseState(members, search('sort=-joined&page=3&filter[role]=admin&search=a'));
    expect(stateQuery(members, state)).toEqual({ sort: '-joined', 'filter[role]': 'admin', search: 'a' });
    expect(stateQuery(members, parseState(members, search('sort=name')))).toEqual({});
  });

  it('is a query schema that throws the 400 out of the router\'s parsing — no per-field fallback for a table', async () => {
    const parsed = await parseQuery(MembersTable.query, search('sort=-joined&tab=x'));
    expect(parsed.value).toEqual({ sort: '-joined', page: 1, per_page: 2, search: '' });
    expect(parsed.canonical).toEqual({ sort: '-joined' });
    expect(parsed.defaults).toEqual({ sort: 'name', page: 1, per_page: 2, search: '' });
    await expect(parseQuery(MembersTable.query, search('sort=password'))).rejects.toThrow(TableQueryError);
    await expect(parseQuery(MembersTable.query, search('per_page=10000'))).rejects.toMatchObject({ status: 400 });
    // Unknown keys of the table's namespace are the resolver's to refuse (the schema cannot see them): parseState does.
    expect(Object.keys(MembersTable.query.entries)).toEqual(['sort', 'page', 'per_page', 'search', 'filter[role]', 'filter[joined]']);
  });

  it('reads ?sort= in the schema of a table whose sortable columns all carry .visible() — no default, but still the table\'s key', async () => {
    const Hidden = defineTable({ query: (db: never) => db, key: 'id', name: 'hidden', columns: { email: column('email').visible(MemberPolicy, 'viewEmails').sortable() } } as never);
    expect(Object.keys(Hidden.query.entries)).toEqual(['sort', 'page', 'per_page']);
    const sorted = await parseQuery(Hidden.query, search('sort=-email'));
    expect(sorted.value.sort).toBe('-email');
    const plain = await parseQuery(Hidden.query, search(''));
    expect(plain.value.sort).toBeUndefined();
    expect(plain.canonical).not.toHaveProperty('sort');
    expect(plain.defaults.sort).toBeUndefined();
    await expect(parseQuery(Hidden.query, search('sort=nope'))).rejects.toThrow(TableQueryError);
  });

  it('stays strict when the entries of two tables, one prefixed, with a cursor, are spread into another r.query()', async () => {
    const page = r.query({ ...MembersTable.query.entries, ...FeedTable.query.entries, tab: r.in(['all', 'mine']).default('all') });
    const parsed = await parseQuery(page, search('filter[role]=admin&feed_per_page=2&tab=mine'));
    expect(parsed.value).toMatchObject({ 'filter[role]': 'admin', page: 1, feed_per_page: 2, tab: 'mine' });
    await expect(parseQuery(page, search('filter[role]=root'))).rejects.toMatchObject({ status: 400 });
    await expect(parseQuery(page, search('feed_sort=password'))).rejects.toThrow(TableQueryError);
  });
});

describe('defineTable at runtime (what the types cannot see)', () => {
  const base = { query: (db: never) => db, key: 'id' } as const;

  it('refuses names that cannot go into a URL, a column named can, a sort that is not sortable, page sizes that are none', () => {
    expect(() => defineTable({ ...base, name: 'two words', columns: { name: column('name') } } as never)).toThrow(/letters, digits/);
    expect(() => defineTable({ ...base, name: 'x', columns: { can: column('name') } } as never)).toThrow(/'can' is taken/);
    expect(() => defineTable({ ...base, name: 'x', columns: { name: column('name') }, defaultSort: 'name' } as never)).toThrow(/not a sortable column/);
    expect(() => defineTable({ ...base, name: 'x', columns: { name: column('name') }, pagination: { perPage: [0] } } as never)).toThrow(/perPage/);
    expect(() => defineTable({ ...base, name: 'x', columns: { name: column('name') }, pagination: { cursor: true } } as never)).toThrow(/cursor pages along a sort/);
    expect(() => defineTable({ ...base, name: 'x', columns: { 'a b': column('name') } } as never)).toThrow(/names are letters/);
    expect(() => column('name; drop table x' as never)).toThrow(/a column of the query/);
    expect(() => filter.select('role', [] as never)).toThrow(/one or more/);
  });

  it('a default sort is every user\'s: never a column with .visible() — whoever may not see it would get a 400 on the page itself', () => {
    const columns = { email: column('email').visible(MemberPolicy, 'viewEmails').sortable(), name: column('name').sortable() };
    expect(() => defineTable({ ...base, name: 'x', columns, defaultSort: '-email' } as never)).toThrow(/defaultSort "-email" is a column with \.visible\(\)/);
    // Without one, the first sortable column everyone sees.
    expect(defineTable({ ...base, name: 'x', columns } as never).definition.defaultSort).toBe('name');
    expect(defineTable({ ...base, name: 'x', columns: { email: columns.email } } as never).definition.defaultSort).toBeUndefined();
  });

  it('refuses a column that has the key\'s name but reads another column', () => {
    expect(() => defineTable({ ...base, name: 'x', columns: { id: column('team_id') } } as never)).toThrow(/rename the column/);
  });
});

describe('keys from the browser, parsed by the key\'s type', () => {
  it.each([
    ['integer', 7, 7],
    ['integer', '7', 7],
    ['integer', '-3', -3],
    ['integer', 'abc', undefined],
    ['integer', '7.5', undefined],
    ['integer', 2.5, undefined],
    ['integer', '99999999999999999', undefined],
    ['integer', '', undefined],
    ['bigint', '9223372036854775807', '9223372036854775807'],
    ['bigint', '9223372036854775808', undefined],
    ['bigint', 42, '42'],
    ['bigint', '1e3', undefined],
    ['uuid', 'A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'],
    ['uuid', 'not-a-uuid', undefined],
    ['string', 'ada@example.com', 'ada@example.com'],
    ['string', 'x'.repeat(201), undefined],
    ['string', { a: 1 }, undefined],
  ] as const)('%s %j → %j', (type, value, expected) => {
    expect(parseKey(type, value)).toEqual(expected);
  });
});
