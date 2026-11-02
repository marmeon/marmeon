// Type guarantees of derived factory columns — checked by `tsc` (pnpm build / typecheck), never run.
import { expectTypeOf } from 'vitest';
import { define, UserFactory } from './__fixtures__/factories.ts';
import type { Factories, PendingFactory } from './index.ts';

export async function derivedFactoryColumns(factories: Factories) {
  define('articles', ({ factory }) => ({
    user_id: factory(UserFactory),
    title: 'T',
    slug: (row) => {
      expectTypeOf(row.title).toEqualTypeOf<string | PendingFactory<any, any, false>>();
      expectTypeOf(row.user_id).toEqualTypeOf<number | PendingFactory<any, any, false>>();
      expectTypeOf(row.slug).toEqualTypeOf<string | null | PendingFactory<any, any, false> | undefined>();
      return String(row.title);
    },
  }));
  // A state takes a derived function and a related factory as a value.
  define('articles', () => ({ user_id: 1, title: 'T' }), { states: { slugged: { slug: (row) => String(row.title) }, by: ({ factory }) => ({ user_id: factory(UserFactory) }) } });
  factories.for(UserFactory).state({ name: 'Ada' });
  // @ts-expect-error — a column the table does not have
  define('articles', () => ({ user_id: 1, title: 'T', slug: (row) => String(row.titel) }));
  // @ts-expect-error — a derived column returns the column's type
  define('articles', () => ({ user_id: 1, title: 'T', slug: () => 1 }));
  // @ts-expect-error — a derived column in a state sees the table's columns only
  define('articles', () => ({ user_id: 1, title: 'T' }), { states: { slugged: { slug: (row) => String(row.nope) } } });
  // @ts-expect-error — an override is a value, not a function
  await factories.for(UserFactory).create({ name: () => 'Ada' });
  // @ts-expect-error — a secret column is not in the row a derived column reads
  define('api_keys', () => ({ user_id: 1, token: 't', name: (row) => String(row.token) }));
  // A factory may set a secret column.
  define('api_keys', () => ({ user_id: 1, token: 't', name: (row) => String(row.user_id) }));
}
