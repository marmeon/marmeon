import { parseQuery } from '@bespokecore/router';
import { describe, expect, it } from 'vitest';
import './__fixtures__/schema.ts';
import { FeedTable, MembersTable } from './__fixtures__/app.ts';
import { column, defineTable, filter } from './index.ts';
import { parseState, queryKeys, stateQuery, TableQueryError } from './state.ts';

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

  it('is a query schema that throws the 400 out of the router\'s parsing — no per-field fallback (E56) for a table', async () => {
    const parsed = await parseQuery(MembersTable.query, search('sort=-joined&tab=x'));
    expect(parsed.value).toEqual({ sort: '-joined', page: 1, per_page: 2, search: '' });
    expect(parsed.canonical).toEqual({ sort: '-joined' });
    expect(parsed.defaults).toEqual({ sort: 'name', page: 1, per_page: 2, search: '' });
    await expect(parseQuery(MembersTable.query, search('sort=password'))).rejects.toThrow(TableQueryError);
    await expect(parseQuery(MembersTable.query, search('per_page=10000'))).rejects.toMatchObject({ status: 400 });
    // Unknown keys of the table's namespace are the resolver's to refuse (the schema cannot see them): parseState does.
    expect(Object.keys(MembersTable.query.entries)).toEqual(['sort', 'page', 'per_page', 'search', 'filter[role]', 'filter[joined]']);
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

  it('refuses a column that has the key\'s name but reads another column', () => {
    expect(() => defineTable({ ...base, name: 'x', columns: { id: column('team_id') } } as never)).toThrow(/rename the column/);
  });
});
