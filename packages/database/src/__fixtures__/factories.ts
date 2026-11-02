import { defineFactory } from '../factories.ts';
import type { FixtureTables } from './tables.ts';

/** `defineFactory` for the fixture tables — apps get theirs typed by the generated `Tables`. */
export const define = <T extends keyof FixtureTables & string, const S extends string = never>(...args: Parameters<typeof defineFactory<T, FixtureTables, S>>) =>
  defineFactory<T, FixtureTables, S>(...args);

export const UserFactory = define(
  'users',
  ({ sequence }) => ({ name: `User ${sequence}`, email: `user${sequence}@example.com` }),
  { states: { admin: { is_admin: true }, rich: ({ sequence }) => ({ balance: `${sequence * 1000}.00` }) } },
);

/** The author comes from the UserFactory — created with the article. */
export const ArticleFactory = define('articles', ({ sequence, factory }) => ({ user_id: factory(UserFactory), title: `Article ${sequence}` }));

const slugOf = (title: unknown) => String(title).toLowerCase().replaceAll(/\W+/g, '-');

/** The slug comes from the title the row ends up with, and the author is named after it: both derived, in that order. */
export const SluggedArticleFactory = define('articles', ({ sequence, factory }) => ({
  user_id: (row) => factory(UserFactory).state({ name: `Author of ${String(row.title)}` }),
  title: `Slugged ${sequence}`,
  slug: (row) => slugOf(row.title),
}));

/** The token is a secret column: a factory sets it, a derived column cannot read it. */
export const ApiKeyFactory = define('api_keys', ({ sequence, factory }) => ({
  user_id: factory(UserFactory),
  token: `token-${sequence}`,
  name: (row) => `key of user ${String(row.user_id)}`,
}));
