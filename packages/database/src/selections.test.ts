import { DummyDriver, Kysely, SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler } from 'kysely';
import { describe, expect, it } from 'vitest';
import { secret, type Secret } from './index.ts';
import { leaveOutSelections, selectionsOf } from './selections.ts';

interface Tables {
  accounts: { id: number; email: string; password: Secret<string> };
  posts: { id: number; account_id: number; title: string };
}

const db = new Kysely<Tables>({
  dialect: { createAdapter: () => new SqliteAdapter(), createDriver: () => new DummyDriver(), createIntrospector: (k) => new SqliteIntrospector(k), createQueryCompiler: () => new SqliteQueryCompiler() },
});

/** An accounts query with two values of its own (`posts`, `label`) and the secret `password`. */
const base = () =>
  db
    .selectFrom('accounts')
    .select((eb) => [
      'accounts.id',
      eb.selectFrom('posts').select(eb.fn.countAll().as('n')).whereRef('posts.account_id', '=', 'accounts.id').as('posts'),
      eb.fn('upper', ['accounts.email']).as('label'),
      secret(eb, 'password'),
    ]);

describe('selectionsOf', () => {
  it('separates the values a query selects under an alias from its secret() selections', () => {
    const { selected, secret: secrets } = selectionsOf(base());
    expect([...selected].sort()).toEqual(['label', 'posts']);
    expect([...secrets]).toEqual(['password']);
  });

  it('knows nothing of a plain column', () => {
    const { selected, secret: secrets } = selectionsOf(db.selectFrom('accounts').select(['id', 'email']));
    expect(selected.size + secrets.size).toBe(0);
  });
});

describe('leaveOutSelections', () => {
  it('removes the named aliases from the compiled SQL and keeps the others', () => {
    const text = leaveOutSelections(base(), new Set(['posts'])).compile().sql;
    expect(text).not.toContain('as "posts"');
    expect(text).toContain('as "label"');
    expect(text).toContain('"accounts"."id"');
  });

  it('removes them when the query is a subquery of another', () => {
    const inner = leaveOutSelections(base(), new Set(['label'])).as('a');
    const text = db.selectFrom(inner).selectAll().compile().sql;
    expect(text).not.toContain('as "label"');
    expect(text).toContain('as "posts"');
  });

  it('gives the same query back for an empty set', () => {
    const query = base();
    expect(leaveOutSelections(query, new Set())).toBe(query);
  });
});
