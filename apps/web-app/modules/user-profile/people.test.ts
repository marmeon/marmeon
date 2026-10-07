import { UserFactory, UserRepository, type User } from '#modules/auth';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import type { ListPeopleController } from './controllers/ListPeopleController.ts';

let app: TestApp;
let ada: User, alan: User;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh', seed: true });
  const users: User[] = await app.make(UserRepository).query().selectAll().orderBy('id').execute();
  [ada, alan] = users as [User, User];
});

const as = (user: User) => app.actingAs(user).navigating();
const names = (props: { people: { data: { name: string }[] } }) => props.people.data.map((person) => person.name);

describe('the people list (/people): state in the URL, parsed by its query schema (E55, E56)', () => {
  it('is for signed-in people only', async () => {
    await app.get('/people', { headers: { accept: 'text/html' } }).assertRedirect('/login');
  });

  it('filters by name — the query trimmed by the schema, LIKE wildcards taken literally', async () => {
    await as(ada).get('/people?q=  TUR ').assertPage<ListPeopleController>('user-profile/People', {
      people: { data: [{ id: alan.id, name: 'Alan Turing', lastLoginAt: null, isMe: false }], meta: { page: 1, perPage: 10, total: 1, lastPage: 1, from: 1, to: 1 } },
    });
    await as(ada).get('/people').assertPage<ListPeopleController>('user-profile/People', (props) => {
      expect(names(props)).toEqual(['Ada Lovelace', 'Alan Turing', 'Grace Hopper']);
      expect(props.people.data[0]!.isMe).toBe(true);
    });
    await as(ada).get('/people?q=%25').assertPage<ListPeopleController>('user-profile/People', { people: { data: [] } });
  });

  it('sorts by name or by sign-up, both ways', async () => {
    const sorted = async (sort: string) => names((await as(ada).get(`/people?sort=${sort}`).assertOk()).page()!.props as never);
    expect(await sorted('-name')).toEqual(['Grace Hopper', 'Alan Turing', 'Ada Lovelace']);
    expect(await sorted('joined')).toEqual(['Ada Lovelace', 'Alan Turing', 'Grace Hopper']);
    expect(await sorted('-joined')).toEqual(['Grace Hopper', 'Alan Turing', 'Ada Lovelace']);
  });

  it('hands the browser the parsed query — without defaults — and the defaults, so it never parses the URL itself', async () => {
    const page = (await as(ada).get('/people?q=%20ada%20&sort=name&utm_source=mail').assertOk()).page()!;
    expect(page.query).toEqual({ q: 'ada' });
    expect(page.queryDefaults).toEqual({ q: '', sort: 'name', page: 1, per_page: 10 });
    // A route without a query schema has none.
    expect((await as(ada).get(`/users/${ada.id}`).assertOk()).page()).not.toHaveProperty('query');
  });

  it('counter-check (E56): ?sort=DROP TABLE → the default, 200, no 422 — the valid fields stay', async () => {
    const response = await as(ada).get('/people?sort=DROP%20TABLE&q=a').assertOk();
    const page = response.page()!;
    expect(page.query).toEqual({ q: 'a' });
    expect(names(page.props as never)).toEqual(['Ada Lovelace', 'Alan Turing', 'Grace Hopper']);
    // A name too long (the schema allows 60) is no error either: the whole list.
    await as(ada).get(`/people?q=${'x'.repeat(61)}`).assertPage<ListPeopleController>('user-profile/People', (props) => expect(props.people.data).toHaveLength(3));
    // Also for a full page load (no JSON), e.g. a link from a mail.
    await app.actingAs(ada).get('/people?sort=nope').assertOk().assertPage('user-profile/People');
  });

  it('pages by the query schema (pageQuery): ?page= and ?per_page= parsed, invalid ones the defaults — never a 422', async () => {
    await app.factory(UserFactory).count(23).create(); // "User 1" … "User 23"
    const seen: string[] = [];
    for (let page = 1; page <= 3; page++) {
      const shown = (await as(ada).get(`/people?q=user&page=${page}`).assertOk()).page()!;
      const props = shown.props as { people: { data: { name: string }[]; meta: { page: number; lastPage: number; total: number } } };
      expect(props.people.meta).toMatchObject({ page, lastPage: 3, total: 23 });
      expect(shown.query).toEqual(page === 1 ? { q: 'user' } : { q: 'user', page });
      seen.push(...names(props));
    }
    expect(seen).toHaveLength(23);
    expect(new Set(seen).size).toBe(23);
    await as(ada).get('/people?per_page=25').assertPage<ListPeopleController>('user-profile/People', (props) => {
      expect(props.people.data).toHaveLength(25);
      expect(props.people.meta).toMatchObject({ perPage: 25, lastPage: 2 });
    });
    // A size the schema does not offer, a page that is none: the defaults (and the canonical query leaves them out).
    const fallback = (await as(ada).get('/people?per_page=100000&page=-3').assertOk()).page()!;
    expect(fallback.query).toEqual({});
    expect((fallback.props as { people: { meta: { page: number; perPage: number } } }).people.meta).toMatchObject({ page: 1, perPage: 10 });
  });
});
