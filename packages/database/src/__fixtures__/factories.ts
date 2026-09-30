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
